import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildChildEnv } from './agent-env.ts';
import type { AgentEvent } from './agent-runner.ts';
import { isRuntimeProviderAuthFailure } from './provider-auth.ts';
import { createRunner } from './runner-factory.ts';
import { GROK_AUTH_FAILURE_MESSAGE } from './grok-ui-mapper.ts';
import { GrokAcpRunner, buildGrokArgs, buildGrokEnv, grokExitMessage } from './grok-acp-runner.ts';
import type { UiEvent } from './ui-events.ts';

/**
 * The `grok` runner over `scripts/mock-grok-acp.mjs`. Frames follow the live `grok` 1.0.46
 * capture in `__fixtures__/grok/README.md`: subscription auth via `cached_token`, a tool announced
 * without an ACP status, and usage on `result._meta.usage`.
 */
const MOCK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'mock-grok-acp.mjs');

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cez-grok-run-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function collect() {
  const events: AgentEvent[] = [];
  const ui: UiEvent[] = [];
  return { events, ui, onEvent: (event: AgentEvent) => events.push(event), onUiEvent: (event: UiEvent) => ui.push(event) };
}

function waitFor(predicate: () => boolean, ms = 10_000): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolveWait();
      if (Date.now() - started > ms) return reject(new Error('timed out waiting'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('buildGrokArgs', () => {
  it('starts a private always-approve ACP agent and does not attach to the user leader', () => {
    expect(buildGrokArgs({})).toEqual(['--no-auto-update', 'agent', '--always-approve', '--no-leader', 'stdio']);
  });

  it('passes --model only when the run names one, and still ends on stdio', () => {
    expect(buildGrokArgs({ model: 'grok-4.7' })).toEqual([
      '--no-auto-update', 'agent', '--always-approve', '--no-leader', '--model', 'grok-4.7', 'stdio',
    ]);
  });
});

describe('buildGrokEnv', () => {
  it('forwards Grok and xAI variables and drops unrelated secrets', () => {
    const child = buildChildEnv({
      backend: 'grok',
      source: {
        PATH: '/usr/bin',
        HOME: '/home/u',
        GROK_HOME: '/tmp/grok-home',
        XAI_API_KEY: 'xai-test',
        AWS_SECRET_ACCESS_KEY: 'nope',
      },
    });
    expect(buildGrokEnv('grok')).toBeTypeOf('object');
    expect(child.GROK_HOME).toBe('/tmp/grok-home');
    expect(child.XAI_API_KEY).toBe('xai-test');
    expect(child.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(child.PATH).toBe('/usr/bin');
  });
});

describe('grokExitMessage', () => {
  it('translates an authentication failure into the line the server latches on', () => {
    expect(grokExitMessage(1, 'You are not authenticated.')).toBe(GROK_AUTH_FAILURE_MESSAGE);
    expect(isRuntimeProviderAuthFailure(GROK_AUTH_FAILURE_MESSAGE)).toBe(true);
  });

  it('otherwise reports the code and the tail of stderr', () => {
    expect(grokExitMessage(7, 'line one\nline two')).toBe('Grok CLI exited with code 7 — line one | line two');
    expect(grokExitMessage(null, '')).toBe('Grok CLI exited with code null');
  });
});

describe('GrokAcpRunner — one turn over the mock', () => {
  const saved = process.env.CEZ_DRY_RUN;
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved;
  });

  it('CEZ_DRY_RUN=1 swaps in the bundled mock and streams both protocols to one done', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const argsFile = join(cwd, 'args.json');
    const collected = collect();
    const session = new GrokAcpRunner().startSession(
      {
        userPrompt: 'fix the login redirect',
        systemPrompt: 'Be terse.',
        cwd,
        model: 'grok-4.7',
        env: { CEZ_MOCK_GROK_ARGS_FILE: argsFile },
      },
      collected.onEvent,
      { autoEndAfterFirstTurn: true, onUiEvent: collected.onUiEvent },
    );
    const result = await session.result;

    const types = collected.events.map((event) => event.type);
    expect(types).toContain('session');
    expect(types).toContain('text');
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    expect(types).toContain('token-usage');
    expect(types.filter((type) => type === 'turn-end')).toHaveLength(1);
    expect(types.filter((type) => type === 'done')).toHaveLength(1);
    expect(types).not.toContain('error');
    // Rules go out on session/new. The user text is not prefixed with the system prompt again.
    expect(result.text).toBe('pong: fix the login redirect');
    expect(result.text).not.toContain('Be terse.');
    expect(result.tokensUsed).toBe(14);
    expect(result.sessionId).toBe('01a103d0-0000-7000-8000-0000000000a1');

    const spawned = JSON.parse(readFileSync(argsFile, 'utf8')) as { argv: string[]; cwd: string };
    expect(spawned.argv).toEqual([
      '--no-auto-update', 'agent', '--always-approve', '--no-leader', '--model', 'grok-4.7', 'stdio',
    ]);
    expect(spawned.cwd).toBe(cwd);

    expect(collected.ui.slice(0, 2).map((event) => event.type)).toEqual(['session.started', 'turn.started']);
    expect(collected.ui).toContainEqual(expect.objectContaining({ type: 'session.started', backend: 'grok', cwd }));
    expect(collected.ui).toContainEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { input: 10, output: 4, total: 14, cacheRead: 0, reasoning: 1 },
    });
    expect(collected.ui.at(-1)).toEqual({ type: 'session.ended', reason: 'end_turn' });
  });

  it('emits a CEZ:DONE split across message chunks as one v1 text before turn-end', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const collected = collect();
    const result = await new GrokAcpRunner().startSession(
      { userPrompt: 'finish the task', cwd, env: { CEZ_MOCK_GROK_SPLIT_MARKER: '1' } },
      collected.onEvent,
      { autoEndAfterFirstTurn: true, onUiEvent: collected.onUiEvent },
    ).result;

    const texts = collected.events.flatMap((event) => (event.type === 'text' ? [event.text] : []));
    // One block. Two events would be joined with a newline and the marker would miss `$`.
    expect(texts).toEqual(['pong: finish the task\nCEZ:DONE']);
    const textAt = collected.events.findIndex((event) => event.type === 'text');
    const turnEndAt = collected.events.findIndex((event) => event.type === 'turn-end');
    expect(textAt).toBeGreaterThan(-1);
    expect(textAt).toBeLessThan(turnEndAt);
    expect(result.text).toBe('pong: finish the task\nCEZ:DONE');

    const deltas = collected.ui.flatMap((event) =>
      event.type === 'item.delta' && event.field === 'text' ? [event.delta] : [],
    );
    expect(deltas).toEqual(['pong: finish the task\nCEZ:', 'DONE']);
  });

  it('reads the first tool frame as running, named from x.ai/tool', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const collected = collect();
    await new GrokAcpRunner().startSession({ userPrompt: 'go', cwd }, collected.onEvent, {
      autoEndAfterFirstTurn: true,
      onUiEvent: collected.onUiEvent,
    }).result;

    const tools = collected.ui.flatMap((event) =>
      (event.type === 'item.started' || event.type === 'item.completed') && event.item.kind === 'tool'
        ? [event.item]
        : []);
    expect(tools.map((item) => item.status)).toEqual(['running', 'completed']);
    expect(tools[0]).toMatchObject({ name: 'read_file', toolKind: 'read' });
  });

  it('is what the factory builds for grok', () => {
    expect(createRunner('grok')).toBeInstanceOf(GrokAcpRunner);
    expect(createRunner('grok').backend).toBe('grok');
  });
});

describe('GrokAcpRunner — session lifecycle', () => {
  it('keeps the same ACP session across a follow-up', async () => {
    const collected = collect();
    const session = new GrokAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'first', cwd }, collected.onEvent, {
      onUiEvent: collected.onUiEvent,
    });
    await waitFor(() => collected.events.filter((event) => event.type === 'turn-end').length === 1);
    expect(session.sendMessage([{ type: 'text', text: 'second' }])).toBe(true);
    await waitFor(() => collected.events.filter((event) => event.type === 'turn-end').length === 2);
    session.end();
    const result = await session.result;

    expect(collected.ui.filter((event) => event.type === 'session.started')).toHaveLength(1);
    expect(collected.ui.filter((event) => event.type === 'turn.started').map((event) => event.type === 'turn.started' && event.turnId))
      .toEqual(['turn_1', 'turn_2']);
    expect(result.text).toContain('second');
    expect(result.tokensUsed).toBe(28);
  });

  it('refuses a message once the session is closed', async () => {
    const collected = collect();
    const session = new GrokAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'hi', cwd }, collected.onEvent, {
      autoEndAfterFirstTurn: true,
    });
    await session.result;
    expect(session.open).toBe(false);
    expect(session.sendMessage([{ type: 'text', text: 'too late' }])).toBe(false);
  });

  it('resumes an existing session with session/load', async () => {
    const collected = collect();
    const session = new GrokAcpRunner({ bin: MOCK }).startSession(
      { userPrompt: 'continue', cwd, resume: true, sessionId: '01a103d0-0000-7000-8000-0000000000b2' },
      collected.onEvent,
      { autoEndAfterFirstTurn: true, onUiEvent: collected.onUiEvent },
    );
    const result = await session.result;

    expect(result.sessionId).toBe('01a103d0-0000-7000-8000-0000000000b2');
    expect(collected.events).toContainEqual({ type: 'session', sessionId: '01a103d0-0000-7000-8000-0000000000b2' });
    expect(collected.events.some((event) => event.type === 'note' && event.message.includes('could not resume'))).toBe(false);
  });

  it('asks a loaded session to change model through set_config_option', async () => {
    const collected = collect();
    const result = await new GrokAcpRunner({ bin: MOCK }).startSession(
      {
        userPrompt: 'continue',
        cwd,
        resume: true,
        sessionId: '01a103d0-0000-7000-8000-0000000000b2',
        model: 'grok-4.6',
      },
      collected.onEvent,
      { autoEndAfterFirstTurn: true },
    ).result;
    expect(result.sessionId).toBe('01a103d0-0000-7000-8000-0000000000b2');
    expect(collected.events.some((event) => event.type === 'note' && event.message.includes('kept its own model'))).toBe(false);
  });

  it('cancel settles the turn as cancelled', async () => {
    const collected = collect();
    const session = new GrokAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'long job', cwd }, collected.onEvent, {
      onUiEvent: collected.onUiEvent,
    });
    await waitFor(() => collected.ui.some((event) => event.type === 'item.started' && event.item.kind === 'tool'));
    session.interrupt();
    await session.result;

    const completed = collected.ui.filter((event) => event.type === 'turn.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ stopReason: 'cancelled' });
    const toolStatuses = collected.ui.flatMap((event) =>
      event.type === 'item.completed' && event.item.kind === 'tool' ? [event.item.status] : []);
    expect(toolStatuses.at(-1)).toBe('failed');
    expect(collected.events.filter((event) => event.type === 'error')).toEqual([]);
  });

  it('auto-approves a permission request and notes it', async () => {
    const collected = collect();
    const session = new GrokAcpRunner({ bin: MOCK }).startSession(
      { userPrompt: 'go', cwd, env: { CEZ_MOCK_GROK_ASK_PERMISSION: '1' } },
      collected.onEvent,
      { autoEndAfterFirstTurn: true, onUiEvent: collected.onUiEvent },
    );
    const result = await session.result;

    expect(collected.events).toContainEqual({
      type: 'note',
      message: 'Grok asked permission for read_file; auto-approved (allow_once) — cezar runs Grok in always-approve mode',
    });
    expect(result.text).toContain('pong:');
    expect(collected.ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'end_turn' }));
  });

  it('notes when authenticate reports API billing instead of a subscription', async () => {
    const collected = collect();
    await new GrokAcpRunner({ bin: MOCK }).startSession(
      { userPrompt: 'go', cwd, env: { CEZ_MOCK_GROK_API_BILLED: '1' } },
      collected.onEvent,
      { autoEndAfterFirstTurn: true },
    ).result;
    expect(collected.events).toContainEqual({
      type: 'note',
      message: 'Grok is billing this run through the xAI API, not a SuperGrok subscription — run `grok login` to use the subscription',
    });
  });

  it('surfaces a missing subscription login as the auth failure the server latches', async () => {
    const collected = collect();
    const session = new GrokAcpRunner({ bin: MOCK }).startSession(
      { userPrompt: 'go', cwd, env: { CEZ_MOCK_GROK_UNAUTHENTICATED: '1' } },
      collected.onEvent,
      { onUiEvent: collected.onUiEvent },
    );
    await session.result;

    expect(collected.events).toContainEqual({ type: 'error', message: GROK_AUTH_FAILURE_MESSAGE });
    expect(collected.ui).toContainEqual({ type: 'session.error', message: GROK_AUTH_FAILURE_MESSAGE, fatal: true });
    expect(collected.ui.at(-1)).toEqual({ type: 'session.ended', reason: 'error' });
  });

  it('drops images when the agent does not advertise them', async () => {
    const collected = collect();
    await new GrokAcpRunner({ bin: MOCK }).startSession(
      {
        userPrompt: 'look',
        cwd,
        images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }],
      },
      collected.onEvent,
      { autoEndAfterFirstTurn: true },
    ).result;
    expect(collected.events).toContainEqual({ type: 'note', message: 'Grok CLI does not accept images; dropped 1' });
  });

  it('reports a missing binary as an install instruction', async () => {
    const session = new GrokAcpRunner({ bin: join(cwd, 'definitely-not-grok') }).startSession(
      { userPrompt: 'go', cwd },
      () => {},
      { autoEndAfterFirstTurn: true },
    );
    await expect(session.result).rejects.toThrow(/not found on PATH.*x\.ai\/cli\/install\.sh/s);
  });
});
