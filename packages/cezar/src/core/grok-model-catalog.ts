import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ModelOption } from './runner-model-catalog.ts';

const exec = promisify(execFile);

export interface GrokModelDiscoveryOptions {
  bin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests — defaults to `execFile(bin, ['models'], …)`. */
  run?: (bin: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_MODELS = 100;

/**
 * Parse `grok models` text. Verified against grok 1.0.46:
 *
 * ```
 * You are logged in with grok.com.
 * Default model: grok-4.7
 * Available models:
 *   * grok-4.7 (default)
 *   - grok-4.7-build-fast
 * ```
 *
 * The starred row is the account's current default. `auto` is not a model id here — cezar's
 * empty-id preset already means "pass no `--model`".
 */
export function parseGrokModelsOutput(text: string): ModelOption[] {
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  let inList = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^available models:?$/i.test(line)) {
      inList = true;
      continue;
    }
    if (!inList || !line) continue;
    const match = /^[*+-]\s+(\S+)(?:\s+\(default\))?$/.exec(line);
    if (!match) continue;
    const id = match[1]!;
    if (!id || seen.has(id)) continue;
    if (models.length >= MAX_MODELS) break;
    seen.add(id);
    const isDefault = line.startsWith('*') || /\(default\)/.test(line);
    models.push({
      id,
      label: id,
      description: isDefault ? 'Account default' : '',
    });
  }
  return models;
}

/** Discover models from the Grok Build CLI (`grok models`). Read-only; uses the saved login. */
export async function discoverGrokModels(options: GrokModelDiscoveryOptions = {}): Promise<ModelOption[]> {
  const bin = options.bin ?? process.env.CEZ_GROK_BIN ?? 'grok';
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const run =
    options.run ??
    (async (executable, runEnv, timeout) =>
      exec(executable, ['models'], { timeout, env: runEnv, maxBuffer: 1024 * 1024 }));

  const { stdout, stderr } = await run(bin, env, timeoutMs);
  const models = parseGrokModelsOutput(`${stdout}\n${stderr}`);
  if (models.length === 0) throw new Error('Grok model discovery returned no models');
  return models;
}
