# Grok Build over ACP — golden fixtures

Verified against `grok` 1.0.46 (`2765805b9442`, stable channel) on 2026-10-04. The CLI was
already signed in (`~/.grok/auth.json`, issuer `auth.x.ai`). `authenticate` with
`methodId: "cached_token"` answered `auth_mode: "Oidc"`, `subscription_tier: "SuperGrok"`,
`backend_billed: false`. That is the SuperGrok subscription path, not `XAI_API_KEY`.

Command used for the live capture (cwd `/tmp/grok-probe`, no leader, always-approve):

```bash
grok --no-auto-update agent --always-approve --no-leader -m grok-4.7 stdio
```

Handshake, then `session/prompt` "Read hello.txt and reply with only its first line."

## Provenance

| Scenario | How the frames were obtained |
|---|---|
| `tool-lifecycle` | **Captured live**, then reduced. Session ids, request ids and the authenticate `_meta` identity fields (email, team) are replaced. `available_commands_update` and other `x.ai/*` notifications that the mapper ignores are dropped. Message chunks that arrived as `probe` / `-` / `line` / `-` / `one` are kept as those five deltas. Token counts are the real `_meta.usage` from that prompt. |
| `schema-plan-reasoning` | **Not a live capture.** Plan entries, `agent_thought_chunk`, a `diff` content block, a `failed` tool update, and a `spawn_subagent` call are the shapes the user guide and the ACP schema name, laid onto the tool-call envelope the live capture actually produced (`_meta["x.ai/tool"]`, no status on the first `tool_call`). Same rule as `__fixtures__/junie/schema-plan-reasoning`. |
| `auth-required` | **Captured in shape, not against a logged-out account that was allowed to prompt.** `grok models` on an empty `GROK_HOME` prints `You are not authenticated.` and exits 0. `initialize` on that home advertised only `grok.com` (no `cached_token`). The error frame uses that sentence. |

Sources:

- User guide shipped with 1.0.46: `~/.grok/docs/user-guide/15-agent-mode.md` (ACP updates, `_meta.yoloMode`, `session/set_config_option`) and `02-authentication.md` (session token beats `XAI_API_KEY`) and `16-subagents.md` (`spawn_subagent`).
- ACP schema: https://agentclientprotocol.com (`plan` entries, `agent_thought_chunk`, content `type: "diff"`, tool status `failed`).
- Live `initialize` capabilities: `loadSession: true`, `promptCapabilities.image: false`.
- Live `session/new` `models.currentModelId`: `grok-4.7`. `grok models` listed `grok-4.7` (default), `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`.

## Where Grok differs from the plain ACP reading

1. **Tool name is `_meta["x.ai/tool"].name`.** The first `tool_call` for `read_file` had no ACP `kind` and `title: "read_file"`. The following update replaced the title with `Read \`/tmp/grok-probe/hello.txt\`` and set `kind: "read"`. The dialect reads the meta name (and meta kind) off the first frame, because the shared mapper does not revise them later.
2. **Usage is `result._meta.usage`.** The prompt result had no top-level `usage`. `_meta.usage` carried `inputTokens`, `outputTokens`, `totalTokens`, `cachedReadTokens`, `reasoningTokens`, `cacheCreationTokens`. Flat `_meta.inputTokens` beside it was the last model call only, so the dialect prefers the nested block.
3. **No parent attribution** was on the captured tool frame. `spawn_subagent` is mapped to tool kind `task` by name. Nesting via `parentItemId` is not claimed.

## Two things the live turn did not emit

- **`agent_thought_chunk`.** The prompt's `_meta.usage.reasoningTokens` was 61, and no thought text arrived. The user guide lists the update, so the schema fixture covers the mapper. A later capture that actually streams thoughts should replace that part.
- **`plan` and `content[].type: "diff"`.** The read-only turn did not exercise them. Same schema-fixture rule.
