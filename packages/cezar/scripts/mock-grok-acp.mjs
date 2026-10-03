#!/usr/bin/env node
/**
 * An offline stand-in for `grok agent stdio`, so `CEZ_DRY_RUN=1` never reaches xAI — the same
 * role `mock-copilot-acp.mjs` plays for Copilot.
 *
 * Frames follow the live `grok` 1.0.46 capture in `src/core/__fixtures__/grok/README.md`:
 * `authenticate` with `cached_token` (SuperGrok, not API-billed), a tool announced without an
 * ACP status, its name under `_meta["x.ai/tool"]`, and per-turn usage on `result._meta.usage`.
 *
 * Deliberately small: enough to prove the transport, the subscription auth step, follow-ups,
 * cancel and resume. It is not a Grok simulator.
 */
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';

const SESSION_ID = '01a103d0-0000-7000-8000-0000000000a1';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const answer = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const update = (sessionId, body) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });

let turn = 0;
let cancelled = false;
/** Set by CEZ_MOCK_GROK_UNAUTHENTICATED=1, so the subscription-login path is testable offline. */
const unauthenticated = process.env.CEZ_MOCK_GROK_UNAUTHENTICATED === '1';
/** Set by CEZ_MOCK_GROK_ASK_PERMISSION=1 so the always-approve auto-answer can be exercised. */
const askPermission = process.env.CEZ_MOCK_GROK_ASK_PERMISSION === '1';
/** Set by CEZ_MOCK_GROK_API_BILLED=1: authenticate succeeds but reports API billing. */
const apiBilled = process.env.CEZ_MOCK_GROK_API_BILLED === '1';
/**
 * Set by CEZ_MOCK_GROK_SPLIT_MARKER=1. The live CLI streams `agent_message_chunk` a token at a
 * time, which is what split `CEZ:DONE` across v1 text events. Two chunks here pin that the
 * runner emits one block ending in the marker.
 */
const splitMarker = process.env.CEZ_MOCK_GROK_SPLIT_MARKER === '1';
const pendingRequests = new Map();
let nextRequestId = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.env.CEZ_MOCK_GROK_ARGS_FILE) {
  writeFileSync(process.env.CEZ_MOCK_GROK_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
}

async function handle(frame) {
  const { id, method, params } = frame;

  if (method === undefined && id !== undefined && pendingRequests.has(id)) {
    pendingRequests.get(id)(frame);
    pendingRequests.delete(id);
    return;
  }

  if (method === 'initialize') {
    answer(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      authMethods: unauthenticated
        ? [{ id: 'grok.com', name: 'Grok' }]
        : [
            { id: 'cached_token', name: 'cached_token' },
            { id: 'grok.com', name: 'Grok' },
          ],
    });
    return;
  }

  if (method === 'authenticate') {
    if (unauthenticated || params?.methodId !== 'cached_token') {
      fail(id, -32000, 'Authentication required');
      return;
    }
    answer(id, {
      _meta: {
        auth_mode: 'Oidc',
        subscription_tier: apiBilled ? null : 'SuperGrok',
        backend_billed: apiBilled,
      },
    });
    return;
  }

  if (method === 'session/new') {
    if (unauthenticated) {
      fail(id, -32000, 'You are not authenticated. Run `grok login`.');
      return;
    }
    answer(id, {
      sessionId: SESSION_ID,
      models: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] },
    });
    return;
  }

  if (method === 'session/load') {
    answer(id, {});
    update(params?.sessionId ?? SESSION_ID, { sessionUpdate: 'available_commands_update', availableCommands: [] });
    return;
  }

  if (method === 'session/set_model' || method === 'session/set_mode' || method === 'session/set_config_option') {
    answer(id, {});
    return;
  }

  if (method === 'session/cancel') {
    cancelled = true;
    return;
  }

  if (method === 'session/prompt') {
    turn += 1;
    cancelled = false;
    const sessionId = params?.sessionId ?? SESSION_ID;
    const text = (params?.prompt ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');

    update(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Reading the request.' },
    });
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: `call_mock_${turn}`,
      title: 'read_file',
      rawInput: { target_file: 'README.md' },
      _meta: { 'x.ai/tool': { version: 1, name: 'read_file', kind: 'read', namespace: 'grok_build' } },
    });
    if (askPermission) {
      const requestId = nextRequestId++;
      const decision = new Promise((resolve) => pendingRequests.set(requestId, resolve));
      send({
        jsonrpc: '2.0',
        id: requestId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: `call_mock_${turn}`, title: 'read_file' },
          options: [
            { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
      await decision;
    }
    await sleep(50);
    if (cancelled) {
      answer(id, { stopReason: 'cancelled' });
      return;
    }
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: `call_mock_${turn}`,
      status: 'completed',
      kind: 'read',
      title: 'Read `README.md`',
      content: [{ type: 'content', content: { type: 'text', text: 'hello' } }],
    });
    const reply = `pong: ${text.slice(0, 80)}`;
    if (splitMarker) {
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `${reply}\nCEZ:` },
      });
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'DONE' },
      });
    } else {
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: reply },
      });
    }
    answer(id, {
      stopReason: 'end_turn',
      _meta: {
        modelId: 'grok-4.7',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedReadTokens: 0, reasoningTokens: 1 },
      },
    });
    return;
  }

  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}

// `for await` ends when stdin closes, so a cezar session that finishes does not sit until the
// EOF kill timer. Same shape as `mock-copilot-acp.mjs`.
for await (const line of readline.createInterface({ input: process.stdin })) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    continue;
  }
  void handle(frame);
}
