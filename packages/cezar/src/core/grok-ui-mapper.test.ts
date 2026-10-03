import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { UiEvent } from './ui-events.ts';
import {
  GROK_AUTH_FAILURE_MESSAGE,
  createGrokUiState,
  grokDialect,
  grokToolName,
  grokUsageFromPromptResult,
  mapGrokFrame,
  type GrokUiMapperState,
} from './grok-ui-mapper.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'grok');

/** Replay a transcript the way the runner drives the mapper: every frame, both directions. */
function replay(fixture: string): UiEvent[] {
  const lines = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8').trim().split('\n');
  let state: GrokUiMapperState = createGrokUiState();
  const events: UiEvent[] = [];
  for (const line of lines) {
    const value = JSON.parse(line) as Record<string, unknown>;
    if ('fixture' in value) continue;
    const mapped = mapGrokFrame(value, state);
    state = mapped.state;
    events.push(...mapped.events);
  }
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

const FIXTURE_NAMES = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.ndjson'))
  .map((file) => file.replace(/\.ndjson$/, ''))
  .sort();

function items(events: UiEvent[]) {
  return events.flatMap((event) =>
    event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed'
      ? [event.item]
      : []);
}

describe('grok agent stdio → v2 golden fixtures', () => {
  it('has a fixture for the live turn, the schema-derived parity rows, and auth', () => {
    expect(FIXTURE_NAMES).toEqual(['auth-required', 'schema-plan-reasoning', 'tool-lifecycle']);
  });

  for (const name of FIXTURE_NAMES) {
    it(`maps ${name} exactly`, () => {
      const expected = JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), 'utf8')) as UiEvent[];
      expect(replay(name)).toStrictEqual(expected);
    });

    it(`${name}: the header cites grok 1.0.46 and a source`, () => {
      const header = JSON.parse(readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8').split('\n')[0]!) as {
        fixture?: { cli?: string; docs?: string; source?: string };
      };
      expect(header.fixture?.cli).toBe('grok 1.0.46 (2765805b9442) [stable]');
      expect(header.fixture?.docs).toBeTruthy();
      expect(header.fixture?.source).toBeTruthy();
    });
  }

  it('reads a status-less tool_call as running and keeps the meta name when the title becomes prose', () => {
    const events = replay('tool-lifecycle');
    const tool = items(events).filter((item) => item.kind === 'tool');
    expect(tool[0]).toMatchObject({ name: 'read_file', toolKind: 'read', status: 'running', title: 'read_file' });
    expect(tool.at(-1)).toMatchObject({
      name: 'read_file',
      toolKind: 'read',
      status: 'completed',
      title: 'Read `/tmp/grok-probe/hello.txt`',
    });
  });

  it('prefers _meta.usage over the flat last-call counts', () => {
    const completed = replay('tool-lifecycle').find((event) => event.type === 'turn.completed');
    expect(completed).toMatchObject({
      stopReason: 'end_turn',
      usage: { input: 32866, output: 92, total: 32958, reasoning: 61, cacheRead: 18048, cacheWrite: 0 },
    });
  });

  it('maps spawn_subagent to a task item without inventing a parent', () => {
    const task = items(replay('schema-plan-reasoning')).find(
      (item) => item.kind === 'tool' && item.name === 'spawn_subagent' && item.status === 'completed',
    );
    expect(task).toMatchObject({ toolKind: 'task', status: 'completed' });
    expect(task?.parentItemId).toBeUndefined();
  });

  it('turns the unauthenticated session/new answer into cezar’s auth line', () => {
    expect(replay('auth-required')).toEqual([
      { type: 'session.error', message: GROK_AUTH_FAILURE_MESSAGE, fatal: true },
    ]);
  });
});

describe('grok dialect', () => {
  it('names itself grok', () => {
    expect(grokDialect.backend).toBe('grok');
  });

  it('takes the tool id from _meta["x.ai/tool"] before the title', () => {
    expect(grokToolName({
      title: 'Read `/tmp/hello.txt`',
      _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read' } },
    })).toBe('read_file');
    expect(grokToolName({ title: 'read_file' })).toBe('read_file');
    expect(grokToolName({ title: 'Read a file', kind: 'read' })).toBe('read');
    expect(grokToolName({})).toBe('tool');
  });

  it('maps spawn_subagent to task and a known meta kind through', () => {
    expect(grokDialect.toolKindOf?.('spawn_subagent', { _meta: { 'x.ai/tool': { kind: 'other' } } })).toBe('task');
    expect(grokDialect.toolKindOf?.('read_file', { _meta: { 'x.ai/tool': { kind: 'read' } } })).toBe('read');
    expect(grokDialect.toolKindOf?.('read_file', {})).toBeUndefined();
  });

  it('ignores a prompt result that has no token counts', () => {
    expect(grokUsageFromPromptResult({ stopReason: 'end_turn' })).toBeUndefined();
    expect(grokUsageFromPromptResult({
      _meta: { inputTokens: 1, outputTokens: 1, totalTokens: 2, usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, reasoningTokens: 1 } },
    })).toEqual({ input: 3, output: 4, total: 7, reasoning: 1 });
  });

  it('rewrites an auth-shaped JSON-RPC error and leaves other errors alone', () => {
    expect(grokDialect.errorMessage?.({ message: 'You are not authenticated. Run `grok login`.' }))
      .toBe(GROK_AUTH_FAILURE_MESSAGE);
    expect(grokDialect.errorMessage?.({ message: 'unknown session id' })).toBeUndefined();
  });
});
