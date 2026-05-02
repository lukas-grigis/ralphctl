/**
 * Defaults used when no `config.json` exists yet, or when a persisted
 * file is missing fields. The `ConfigStorePort.load()` contract is
 * "always returns a complete `Config`" — these defaults underwrite that.
 */
import type { Config } from './config.ts';

export const CONFIG_DEFAULTS: Config = {
  currentSprint: null,
  aiProvider: null,
  editor: null,
  evaluationIterations: 1,
  logLevel: 'info',
};
