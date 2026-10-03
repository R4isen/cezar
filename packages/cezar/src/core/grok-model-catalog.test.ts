import { describe, expect, it } from 'vitest';

import { discoverGrokModels, parseGrokModelsOutput } from './grok-model-catalog.ts';

const LOGGED_IN = `
You are logged in with grok.com.

Default model: grok-4.7

Available models:
  * grok-4.7 (default)
  - grok-4.7-build-fast
  - grok-4.6
  - grok-4.5
`;

describe('parseGrokModelsOutput', () => {
  it('reads the starred account default and the dashed ids', () => {
    expect(parseGrokModelsOutput(LOGGED_IN)).toEqual([
      { id: 'grok-4.7', label: 'grok-4.7', description: 'Account default' },
      { id: 'grok-4.7-build-fast', label: 'grok-4.7-build-fast', description: '' },
      { id: 'grok-4.6', label: 'grok-4.6', description: '' },
      { id: 'grok-4.5', label: 'grok-4.5', description: '' },
    ]);
  });

  it('ignores the login banner and a duplicate id', () => {
    expect(parseGrokModelsOutput('You are not authenticated.\nAvailable models:\n  - grok-4.6\n  - grok-4.6\n')).toEqual([
      { id: 'grok-4.6', label: 'grok-4.6', description: '' },
    ]);
  });

  it('returns nothing when the list is absent', () => {
    expect(parseGrokModelsOutput('You are not authenticated.\n')).toEqual([]);
  });
});

describe('discoverGrokModels', () => {
  it('parses the injected command output and throws when it lists nothing', async () => {
    await expect(discoverGrokModels({
      run: async () => ({ stdout: LOGGED_IN, stderr: '' }),
    })).resolves.toHaveLength(4);

    await expect(discoverGrokModels({
      run: async () => ({ stdout: 'You are not authenticated.\n', stderr: '' }),
    })).rejects.toThrow(/no models/);
  });
});
