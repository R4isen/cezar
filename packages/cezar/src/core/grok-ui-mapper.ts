/**
 * Grok Build's ACP dialect — the per-runner mapper `AGENT_PROTOCOL.md` §9 step 4 asks for, over
 * the shared `acp-ui-mapper.ts`.
 *
 * Verified live against `grok` 1.0.46 (`2765805b9442`, stable) on 2026-10-04, signed in with a
 * SuperGrok subscription (`authenticate` → `subscription_tier: "SuperGrok"`, `auth_mode: "Oidc"`,
 * `backend_billed: false`). The record is `__fixtures__/grok/README.md`.
 *
 * What the live wire does that the plain ACP reading does not:
 *  - a tool's own name is `_meta["x.ai/tool"].name` (`read_file`). The first `tool_call` often
 *    has no ACP `kind` and uses that raw name as `title`; a later update replaces the title with
 *    prose ("Read `/tmp/…`"). The name has to be taken from `_meta` on the first frame, because
 *    the shared mapper freezes `name` and `toolKind` from that frame.
 *  - per-turn token counts are NOT `session/prompt` `result.usage`. They ride on `result._meta`,
 *    and `_meta.usage` is the whole prompt (several model calls). Field names differ from ACP:
 *    `reasoningTokens` rather than `thoughtTokens`, `cacheCreationTokens` rather than
 *    `cachedWriteTokens`.
 *  - delegation is the `spawn_subagent` tool (user guide §16), not an ACP kind `task`.
 */
import {
  createAcpUiState,
  mapAcpFrame,
  type AcpDialect,
  type AcpUiMapperState,
  type AcpUiMapping,
} from './acp-ui-mapper.ts';
import type { TokenUsage, ToolKind } from './ui-events.ts';

/** Grok's own `_meta` namespace on tool-call frames. `name` is the tool id (`read_file`). */
export const GROK_TOOL_META_KEY = 'x.ai/tool';

/** What a user needs in order to run Grok Build on a SuperGrok (or X Premium+) subscription. */
export const GROK_AUTH_HINT =
  'Grok Build needs a SuperGrok or X Premium+ login — run `grok login` (browser or `grok login --device-auth`). An `XAI_API_KEY` is only the CLI\'s fallback when no subscription session is saved.';

/**
 * The run-time line for a rejected credential. "authentication failed" is what
 * `isRuntimeProviderAuthFailure` keys on, so the server raises `provider-auth-required`.
 */
export const GROK_AUTH_FAILURE_MESSAGE =
  'Grok CLI authentication failed — run `grok login` to use your SuperGrok or X Premium+ subscription.';

const AUTH_FAILURE_PATTERNS = [
  /authentication failed/i,
  /authentication required/i,
  /not authenticated/i,
  /not logged in/i,
  /\bgrok login\b/i,
  /sign in to grok/i,
] as const;

const TOOL_KINDS = new Set<ToolKind>([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'other',
  'task',
]);

/** True for the Grok auth failures cezar has seen (`grok models` and ACP errors). */
export function isGrokAuthFailure(text: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The tool id Grok stamps on the frame. Falls back to a raw-name title (`read_file`). */
export function grokToolName(update: Record<string, unknown>): string {
  const named = grokToolMeta(update);
  if (named?.name) return named.name;
  if (typeof update.title === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(update.title)) return update.title;
  return typeof update.kind === 'string' && update.kind ? update.kind : 'tool';
}

function grokToolMeta(update: Record<string, unknown>): { name?: string; kind?: string } | undefined {
  const meta = isRecord(update._meta) ? update._meta : undefined;
  const tool = meta && isRecord(meta[GROK_TOOL_META_KEY]) ? meta[GROK_TOOL_META_KEY] : undefined;
  if (!tool) return undefined;
  const name = typeof tool.name === 'string' && tool.name ? tool.name : undefined;
  const kind = typeof tool.kind === 'string' && tool.kind ? tool.kind : undefined;
  return name || kind ? { name, kind } : undefined;
}

/**
 * `spawn_subagent` is Grok's delegation tool (user guide §16). Everything else keeps the kind
 * Grok already put on `_meta["x.ai/tool"]` when it is one the cockpit knows.
 */
function grokToolKind(name: string, update: Record<string, unknown>): ToolKind | undefined {
  if (name === 'spawn_subagent') return 'task';
  const kind = grokToolMeta(update)?.kind;
  return kind && TOOL_KINDS.has(kind as ToolKind) ? (kind as ToolKind) : undefined;
}

/**
 * Token counts for one `session/prompt`. Prefer `_meta.usage` (the whole prompt, live on
 * 1.0.46) over the flat last-call fields that sit beside it.
 */
export function grokUsageFromPromptResult(result: Record<string, unknown>): TokenUsage | undefined {
  const meta = isRecord(result._meta) ? result._meta : undefined;
  if (!meta) return undefined;
  const block = isRecord(meta.usage) ? meta.usage : meta;
  const input = number(block.inputTokens) ?? 0;
  const output = number(block.outputTokens) ?? 0;
  const total = number(block.totalTokens) ?? input + output;
  if (total <= 0) return undefined;
  const cacheRead = number(block.cachedReadTokens);
  const cacheWrite = number(block.cacheCreationTokens);
  const reasoning = number(block.reasoningTokens);
  return {
    input,
    output,
    total,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

export const grokDialect: AcpDialect = {
  backend: 'grok',
  toolNameOf: grokToolName,
  toolKindOf: grokToolKind,
  usageFromPromptResult: grokUsageFromPromptResult,
  errorMessage: (error) => {
    const text = `${typeof error.message === 'string' ? error.message : ''} ${JSON.stringify(error.data ?? '')}`;
    return isGrokAuthFailure(text) ? GROK_AUTH_FAILURE_MESSAGE : undefined;
  },
};

export type GrokUiMapperState = AcpUiMapperState;

export function createGrokUiState(): GrokUiMapperState {
  return createAcpUiState();
}

export function mapGrokFrame(frame: unknown, state: GrokUiMapperState): AcpUiMapping {
  return mapAcpFrame(frame, state, grokDialect);
}
