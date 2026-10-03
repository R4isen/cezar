import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSignalTerminationExit,
  trackChildExit,
  type AgentBackend,
  type AgentEvent,
  type AgentRunResult,
  type AgentRunSpec,
  type AgentRunner,
  type AgentSession,
  type AgentToolCallRecord,
  type ContentBlock,
  type SessionOptions,
} from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { AcpClient, type AcpContentBlock, type AcpMessage, type AcpRequestAnswer } from './acp-client.ts';
import { abortAcpTurn, endAcpReplay, mapAcpFrame, type AcpUiMapperState } from './acp-ui-mapper.ts';
import { EOF_KILL_GRACE_MS, EOF_TERM_GRACE_MS } from './claude-cli-runner.ts';
import {
  GROK_AUTH_FAILURE_MESSAGE,
  createGrokUiState,
  grokDialect,
  isGrokAuthFailure,
} from './grok-ui-mapper.ts';
import type { UiEvent } from './ui-events.ts';
import { V1TextCoalescer } from './v1-text-coalescer.ts';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** `initialize` / `authenticate` / `session/new` / `session/load` are handshakes: bounded, unlike a prompt. */
const HANDSHAKE_TIMEOUT_MS = 90_000;
/**
 * How long to wait for the end of a `session/load` replay (`available_commands_update`) before
 * prompting anyway. Grok 1.0.46 advertises `loadSession: true` and emits that marker during
 * `session/new` as well; the wait is a bound, not an assumption that a loaded session replays.
 */
const REPLAY_WAIT_MS = 5_000;
const AUTO_END_DELAY_MS = 250;

/** The ACP auth method that uses the saved SuperGrok / X Premium+ session (`grok login`). */
const CACHED_TOKEN_METHOD = 'cached_token';

export interface GrokAcpRunnerOptions {
  /** Override the binary; defaults to `grok` on PATH (`CEZ_GROK_BIN`). */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

/**
 * Grok Build over the Agent Client Protocol: one long-lived `grok agent stdio` child and one
 * ACP session per cezar session. Follow-ups are further `session/prompt` calls on the same
 * process; Continue resumes with `session/load`.
 *
 * The wire was verified against `grok` 1.0.46 — see `__fixtures__/grok/README.md`. Auth is the
 * subscription login, not an API key: when `initialize` advertises `cached_token`, the runner
 * calls `authenticate` with that method before `session/new`. Live, that answer carries
 * `subscription_tier: "SuperGrok"` and `backend_billed: false`. The CLI's own rule is the same
 * one (user guide § Authentication: a saved session token takes precedence over `XAI_API_KEY`).
 *
 * Permissions are always-approve (`--always-approve` plus `_meta.yoloMode`). A
 * `session/request_permission` that still arrives is auto-approved with a note, so no request
 * can park a run nothing is able to wake.
 */
export class GrokAcpRunner implements AgentRunner {
  readonly backend = 'grok' as const;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: GrokAcpRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.CEZ_GROK_BIN ?? (process.env.CEZ_DRY_RUN === '1' ? mockGrokPath() : 'grok');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts: SessionOptions = {}): AgentSession {
    const session = new GrokAcpSession(this.bin, this.backend, spec, spec.timeoutMs ?? this.timeoutMs, onEvent, opts);
    this.lastSession = session;
    return session;
  }
}

/**
 * The CLI flags for one run. Every one is from `grok --help` / `grok agent --help` on 1.0.46
 * and was used in the live handshake (`__fixtures__/grok/README.md`):
 *
 * - `agent stdio` is the ACP server on stdin/stdout (user guide § Agent mode).
 * - `--always-approve` is the automation permission mode. Deny rules and hooks still apply.
 * - `--no-leader` starts a private agent. Without it a machine whose config enables leader mode
 *   would attach this task to the user's already-running Grok, sharing that session.
 * - `--no-auto-update` because a CLI that swaps itself out mid-task is not reproducible.
 * - `--model` is the agent-level `-m` flag. It applies to the session this process creates.
 *
 * `spec.allowedTools` / `spec.bashAllowlist` are not translated. Grok's permission model is
 * modes plus allow/deny rules, and a partial mapping would look like a sandbox while the
 * process is in always-approve. `additionalDirectories` has no flag on this CLI.
 */
export function buildGrokArgs(spec: Pick<AgentRunSpec, 'model'>): string[] {
  const args = ['--no-auto-update', 'agent', '--always-approve', '--no-leader'];
  if (spec.model) args.push('--model', spec.model);
  args.push('stdio');
  return args;
}

/** The per-run environment: `buildChildEnv`'s least-privilege set for this backend. */
export function buildGrokEnv(backend: AgentBackend, extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  return buildChildEnv({ backend, extraEnv });
}

/**
 * A cezar-authored line for an exit outside a prompt. Grok documents 0 / 1 / 130 / 143
 * (user guide § Headless, exit codes). The one case worth translating is an authentication
 * failure, because that wording is what raises `provider-auth-required`.
 */
export function grokExitMessage(exitCode: number | null, stderr: string): string {
  if (isGrokAuthFailure(stderr)) return GROK_AUTH_FAILURE_MESSAGE;
  const detail = stderr.trim().split('\n').slice(-3).join(' | ');
  return `Grok CLI exited with code ${exitCode}${detail ? ` — ${truncate(detail, 400)}` : ''}`;
}

class GrokAcpSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;
  readonly pid?: number;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly client: AcpClient;
  private readonly hasExited: () => boolean;
  private ui: AcpUiMapperState = createGrokUiState();
  private acpSessionId: string | undefined;
  private loadSupported = false;
  private imagesSupported = false;

  private isOpen = true;
  private turnInFlight = false;
  private turnsCompleted = 0;
  private readonly queue: AcpContentBlock[][] = [];
  private terminatedByCezar = false;
  private timedOut = false;
  private failed: string | null = null;
  private replayDone: (() => void) | null = null;

  private readonly textChunks: string[] = [];
  /**
   * Grok streams `agent_message_chunk` a token at a time. Emitting each delta as its own v1
   * `text` event makes `appendTurnText` join them with newlines, so a marker split as `CEZ:` +
   * `DONE` never matches `/CEZ:DONE\s*$/` and the run parks at `waiting`. v2 `item.delta` still
   * streams live; v1 is one block per finished message, flushed before `turn-end`.
   */
  private readonly textCoalescer = new V1TextCoalescer((text) => {
    this.textChunks.push(text);
    this.emit({ type: 'text', text });
  });
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private tokensUsed = 0;
  private readonly stderr: string[] = [];
  private spawnError: Error | null = null;
  private autoEndTimer: NodeJS.Timeout | undefined;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    bin: string,
    backend: AgentBackend,
    private readonly spec: AgentRunSpec,
    private readonly limitMs: number,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions,
  ) {
    this.child = nodeSpawn(bin, buildGrokArgs(spec), { cwd: spec.cwd, env: buildGrokEnv(backend, spec.env) });
    this.pid = this.child.pid;
    this.hasExited = trackChildExit(this.child);
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      this.spawnError =
        error.code === 'ENOENT'
          ? new Error(`\`${bin}\` not found on PATH — install Grok Build (curl -fsSL https://x.ai/cli/install.sh | bash) and run \`grok login\``)
          : error;
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
    this.client = new AcpClient(this.child.stdin, this.child.stdout, {
      onFrame: (dir, frame) => this.onFrame(dir, frame),
      onRequest: (request) => this.onRequest(request),
      onUnparseable: (line) => this.emit({ type: 'note', message: `grok: skipped unparseable ACP line: ${truncate(line, 200)}` }),
    });

    if (this.limitMs > 0) {
      const deadline = setTimeout(() => {
        this.timedOut = true;
        this.interrupt();
      }, this.limitMs);
      deadline.unref?.();
      this.timers.push(deadline);
    }
    this.result = this.lifecycle();
  }

  get open(): boolean {
    return this.isOpen;
  }

  sendMessage(content: ContentBlock[]): boolean {
    if (!this.isOpen || this.client.closed) return false;
    if (this.autoEndTimer) {
      clearTimeout(this.autoEndTimer);
      this.autoEndTimer = undefined;
    }
    this.queue.push(this.toAcp(content));
    this.pump();
    return true;
  }

  end(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.terminate(false);
  }

  interrupt(): void {
    if (this.acpSessionId && this.turnInFlight) this.client.cancel(this.acpSessionId);
    this.isOpen = false;
    this.terminate(true);
  }

  private async lifecycle(): Promise<AgentRunResult> {
    const reading = this.client.run();
    const exited = waitForExit(this.child);
    try {
      await this.bootstrap();
    } catch (error) {
      if (!this.spawnError && !this.client.closed) this.fail(error instanceof Error ? error.message : String(error));
      this.terminate(false);
    }

    await reading;
    const exitCode = await exited;
    for (const timer of this.timers) clearTimeout(timer);
    if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
    this.isOpen = false;

    if (this.spawnError) throw this.spawnError;
    if (this.turnInFlight) {
      this.turnInFlight = false;
      if (this.timedOut) this.applyUi(abortAcpTurn(this.ui, grokDialect, 'timeout'));
      else if (this.terminatedByCezar) this.applyUi(abortAcpTurn(this.ui, grokDialect, 'cancelled'));
      else {
        const reason = grokExitMessage(exitCode, this.stderrText());
        this.applyUi(abortAcpTurn(this.ui, grokDialect, 'error', reason));
        this.fail(reason);
      }
    }
    this.textCoalescer.flush();
    const summary = (): AgentRunResult => ({
      text: this.textChunks.join('\n').trim(),
      toolCalls: this.toolCalls,
      tokensUsed: this.tokensUsed,
      ...(this.acpSessionId ? { sessionId: this.acpSessionId } : {}),
    });

    if (this.timedOut) {
      const minutes = Math.round((this.limitMs / 60_000) * 10) / 10;
      this.emit({ type: 'error', message: `Grok CLI timed out after ${minutes}m and was killed` });
      this.emit({ type: 'done' });
      return summary();
    }
    if (this.failed) {
      this.opts.onUiEvent?.({ type: 'session.ended', reason: 'error' });
      this.emit({ type: 'done' });
      return summary();
    }
    if (!this.acpSessionId && !this.terminatedByCezar && (exitCode === 0 || exitCode === null)) {
      this.fail('Grok CLI exited before it started a session');
      this.opts.onUiEvent?.({ type: 'session.ended', reason: 'error' });
      this.emit({ type: 'done' });
      return summary();
    }
    if (exitCode !== 0 && exitCode !== null) {
      if (this.terminatedByCezar && (isSignalTerminationExit(exitCode) || exitCode === 1)) {
        this.emit({ type: 'note', message: `Grok CLI exited ${exitCode} after cezar stopped it` });
      } else if (!this.terminatedByCezar) {
        const message = grokExitMessage(exitCode, this.stderrText());
        this.emit({ type: 'error', message });
        throw new Error(message);
      }
    }
    if (this.tokensUsed === 0 && this.turnsCompleted > 0) {
      this.emit({ type: 'note', message: 'token usage not reported by Grok CLI' });
    }
    this.opts.onUiEvent?.({ type: 'session.ended', reason: this.terminatedByCezar && this.turnsCompleted === 0 ? 'cancelled' : 'end_turn' });
    this.emit({ type: 'done' });
    return summary();
  }

  private async bootstrap(): Promise<void> {
    const init = await this.client.initialize(HANDSHAKE_TIMEOUT_MS);
    const caps = isRecord(init.agentCapabilities) ? init.agentCapabilities : {};
    this.loadSupported = caps.loadSession === true;
    this.imagesSupported = isRecord(caps.promptCapabilities) && caps.promptCapabilities.image === true;
    const authMethods = authMethodIds(init.authMethods);

    if (authMethods.has(CACHED_TOKEN_METHOD)) {
      const authenticated = await this.client
        .request('authenticate', { methodId: CACHED_TOKEN_METHOD, _meta: { headless: true } }, { timeoutMs: HANDSHAKE_TIMEOUT_MS })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            isGrokAuthFailure(`${message}\n${this.stderrText()}`)
              ? GROK_AUTH_FAILURE_MESSAGE
              : `Grok CLI could not use the saved subscription login: ${message}`,
          );
        });
      const meta = isRecord(authenticated._meta) ? authenticated._meta : undefined;
      if (meta?.backend_billed === true) {
        this.emit({
          type: 'note',
          message: 'Grok is billing this run through the xAI API, not a SuperGrok subscription — run `grok login` to use the subscription',
        });
      }
    } else {
      this.emit({
        type: 'note',
        message: 'Grok has no saved subscription login (`cached_token`). Run `grok login` for SuperGrok or X Premium+; this run continues with whatever credential the CLI still has.',
      });
    }

    if (this.spec.resume && this.spec.sessionId) {
      if (this.loadSupported) {
        const replayEnded = new Promise<void>((resolve) => {
          this.replayDone = resolve;
        });
        try {
          await this.client.loadSession(this.spec.sessionId, this.spec.cwd, HANDSHAKE_TIMEOUT_MS);
          this.acpSessionId = this.spec.sessionId;
          await Promise.race([replayEnded, delay(REPLAY_WAIT_MS)]);
          this.ui = endAcpReplay(this.ui);
        } catch (error) {
          this.replayDone = null;
          this.ui = endAcpReplay(this.ui);
          this.acpSessionId = undefined;
          this.emit({
            type: 'note',
            message: `Grok could not resume session ${this.spec.sessionId} (${error instanceof Error ? error.message : String(error)}) — starting a fresh session`,
          });
        }
      } else {
        this.emit({ type: 'note', message: 'Grok CLI does not advertise session/load — starting a fresh session' });
      }
    }
    if (!this.acpSessionId) {
      const rules = this.spec.systemPrompt?.trim();
      const created = await this.client
        .request(
          'session/new',
          {
            cwd: this.spec.cwd,
            mcpServers: [],
            _meta: { yoloMode: true, ...(rules ? { rules } : {}) },
          },
          { timeoutMs: HANDSHAKE_TIMEOUT_MS },
        )
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            isGrokAuthFailure(`${message}\n${this.stderrText()}`)
              ? GROK_AUTH_FAILURE_MESSAGE
              : `Grok CLI could not start a session: ${message}`,
          );
        });
      const id = typeof created.sessionId === 'string' ? created.sessionId : undefined;
      if (!id) throw new Error('Grok CLI answered session/new without a sessionId');
      this.acpSessionId = id;
    } else if (this.spec.model) {
      // `--model` only reaches a session this process created. A loaded one keeps its saved
      // model, so a run whose model changed asks via the config option the user guide documents
      // (`session/set_config_option`, value wrapped as `{value}`).
      await this.client
        .request(
          'session/set_config_option',
          { sessionId: this.acpSessionId, configId: 'model', value: { value: this.spec.model } },
          { timeoutMs: HANDSHAKE_TIMEOUT_MS },
        )
        .catch((error: unknown) => {
          this.emit({
            type: 'note',
            message: `Grok kept its own model: session/set_config_option failed (${error instanceof Error ? error.message : String(error)})`,
          });
        });
    }
    this.emit({ type: 'session', sessionId: this.acpSessionId });

    // System prompt goes out as `_meta.rules` on session/new (Grok's native channel). The user
    // text is not prefixed with it again.
    const first: ContentBlock[] = [...(this.spec.images ?? []), { type: 'text', text: this.spec.userPrompt }];
    this.queue.unshift(this.toAcp(first));
    this.pump();
  }

  private pump(): void {
    if (this.turnInFlight || !this.acpSessionId || this.queue.length === 0 || this.client.closed) return;
    const prompt = this.queue.shift()!;
    this.turnInFlight = true;
    this.client.prompt(this.acpSessionId, prompt).then(
      () => this.turnEnded(),
      () => {
        if (!this.client.closed) this.turnEnded();
      },
    );
  }

  private turnEnded(): void {
    if (!this.turnInFlight) return;
    this.turnInFlight = false;
    this.turnsCompleted += 1;
    // RunManager reads `CEZ:DONE` off the v1 text it has already seen when this event arrives.
    // A message that never got `item.completed` (cancel, dead child) still has to surface first.
    this.textCoalescer.flush();
    this.emit({ type: 'turn-end' });
    if (this.queue.length > 0) {
      this.pump();
      return;
    }
    if (this.opts.autoEndAfterFirstTurn && this.isOpen && !this.autoEndTimer) {
      this.autoEndTimer = setTimeout(() => this.end(), AUTO_END_DELAY_MS);
      this.autoEndTimer.unref?.();
    }
  }

  private onFrame(dir: 'in' | 'out', frame: AcpMessage): void {
    if (
      dir === 'in'
      && this.replayDone
      && isRecord(frame.params)
      && isRecord(frame.params.update)
      && frame.params.update.sessionUpdate === 'available_commands_update'
    ) {
      const done = this.replayDone;
      this.replayDone = null;
      queueMicrotask(done);
    }
    this.applyUi(mapAcpFrame({ dir, frame }, this.ui, grokDialect));
  }

  private applyUi(mapped: { events: UiEvent[]; state: AcpUiMapperState }): void {
    this.ui = mapped.state;
    for (const event of mapped.events) {
      this.opts.onUiEvent?.(event);
      this.v1FromUi(event);
    }
  }

  private v1FromUi(event: UiEvent): void {
    switch (event.type) {
      case 'item.delta':
        if (event.field === 'text') this.textCoalescer.append(event.itemId, event.delta);
        return;
      case 'item.started':
        if (event.item.kind === 'tool') {
          const input = event.item.input ?? { title: event.item.title };
          this.toolCalls.push({ id: event.item.id, name: event.item.name, input });
          this.emit({ type: 'tool-call', id: event.item.id, tool: event.item.name, input });
        }
        return;
      case 'item.completed':
        if (event.item.kind === 'message') {
          this.textCoalescer.complete(event.item.id, event.item.text);
          return;
        }
        if (event.item.kind === 'tool') {
          const failed = event.item.status === 'failed' || event.item.status === 'declined';
          this.emit({
            type: 'tool-result',
            toolCallId: event.item.id,
            result: (failed ? event.item.error : event.item.output) ?? '',
            isError: failed,
          });
        }
        return;
      case 'image':
        this.emit({ type: 'image', mediaType: event.mediaType, data: event.data });
        return;
      case 'usage.updated':
        this.tokensUsed = event.usage.total;
        this.emit({ type: 'token-usage', tokensUsed: this.tokensUsed });
        return;
      case 'session.error':
        if (event.fatal || this.turnInFlight) this.fail(event.message);
        return;
      default:
        return;
    }
  }

  private onRequest(request: AcpMessage): AcpRequestAnswer {
    if (request.method !== 'session/request_permission' || !isRecord(request.params)) {
      return { error: { code: -32601, message: `Method not found: ${String(request.method)}` } };
    }
    const options = Array.isArray(request.params.options) ? request.params.options.filter(isRecord) : [];
    const choice =
      options.find((option) => option.kind === 'allow_always') ??
      options.find((option) => option.kind === 'allow_once') ??
      options[0];
    const title =
      isRecord(request.params.toolCall) && typeof request.params.toolCall.title === 'string'
        ? request.params.toolCall.title
        : 'a tool call';
    if (!choice || typeof choice.optionId !== 'string') {
      this.emit({ type: 'note', message: `Grok asked permission for ${title} with no option cezar could pick; cancelled` });
      return { result: { outcome: { outcome: 'cancelled' } } };
    }
    this.emit({
      type: 'note',
      message: `Grok asked permission for ${title}; auto-approved (${String(choice.kind ?? choice.optionId)}) — cezar runs Grok in always-approve mode`,
    });
    return { result: { outcome: { outcome: 'selected', optionId: choice.optionId } } };
  }

  private toAcp(content: ContentBlock[]): AcpContentBlock[] {
    const blocks: AcpContentBlock[] = [];
    let droppedImages = 0;
    for (const block of content) {
      if (block.type === 'text') blocks.push({ type: 'text', text: block.text });
      else if (this.imagesSupported || !this.acpSessionId) {
        blocks.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type });
      } else droppedImages += 1;
    }
    if (droppedImages > 0) this.emit({ type: 'note', message: `Grok CLI does not accept images; dropped ${droppedImages}` });
    return blocks;
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = message;
    this.emit({ type: 'error', message });
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  private stderrText(): string {
    return this.stderr.join('');
  }

  private terminate(hard: boolean): void {
    try {
      this.child.stdin.end();
    } catch {
      // already gone
    }
    const signal = (sig: NodeJS.Signals): void => {
      if (this.hasExited()) return;
      this.terminatedByCezar = true;
      this.child.kill(sig);
    };
    if (hard) {
      this.terminatedByCezar = true;
      signal('SIGTERM');
      const kill = setTimeout(() => signal('SIGKILL'), EOF_KILL_GRACE_MS);
      kill.unref?.();
      this.timers.push(kill);
      return;
    }
    const term = setTimeout(() => {
      signal('SIGTERM');
      const kill = setTimeout(() => signal('SIGKILL'), EOF_KILL_GRACE_MS);
      kill.unref?.();
      this.timers.push(kill);
    }, EOF_TERM_GRACE_MS);
    term.unref?.();
    this.timers.push(term);
  }
}

function authMethodIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) return ids;
  for (const method of value) {
    if (isRecord(method) && typeof method.id === 'string' && method.id) ids.add(method.id);
  }
  return ids;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(child.exitCode ?? null));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Path to the bundled mock (`scripts/mock-grok-acp.mjs`), for CEZ_DRY_RUN=1. */
function mockGrokPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, '..', '..', 'scripts', 'mock-grok-acp.mjs');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
