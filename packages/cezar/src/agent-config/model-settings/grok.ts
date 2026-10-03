import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * Grok Build has no native settings file cezar should read a default model out of.
 *
 * The picker discovers ids with `grok models`, and a chosen id is passed as `--model` by the
 * runner. There is no documented `GROK_MODEL` variable (user guide shipped with 1.0.46), so this
 * strategy reports nothing rather than inventing one. An empty read means "the account default".
 */
export const grokModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'grok',
  async read() {
    return {};
  },
};
