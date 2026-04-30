import { describe, expect, it } from 'vitest';

import { CONFIG_DEFAULTS } from './config-defaults.ts';

describe('CONFIG_DEFAULTS', () => {
  it('exposes a fresh-install Config', () => {
    expect(CONFIG_DEFAULTS.currentSprint).toBeNull();
    expect(CONFIG_DEFAULTS.aiProvider).toBeNull();
    expect(CONFIG_DEFAULTS.editor).toBeNull();
    expect(CONFIG_DEFAULTS.evaluationIterations).toBe(1);
    expect(CONFIG_DEFAULTS.logLevel).toBe('info');
  });

  it('has every key the Config type requires', () => {
    // Snapshot of the public field set so a future field addition fails
    // this test until the defaults are updated.
    expect(Object.keys(CONFIG_DEFAULTS).sort()).toEqual([
      'aiProvider',
      'currentSprint',
      'editor',
      'evaluationIterations',
      'logLevel',
    ]);
  });
});
