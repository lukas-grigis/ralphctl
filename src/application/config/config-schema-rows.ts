/**
 * CONFIG_ROWS — companion metadata for rendering the settings panel.
 *
 * Each entry maps one `Config` field to a display label, description, prompt
 * kind, and optional option list.  The settings view iterates this array —
 * adding a new config key requires a row here (+ a default in
 * `config-defaults.ts`); nothing else changes on the UI side.
 *
 * `currentSprint` is intentionally absent: it is a runtime pointer managed by
 * sprint commands, not a user-configurable setting.
 */

import type { Config } from './config.ts';

export type RowKind = 'select' | 'confirm' | 'input';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface ConfigRow {
  /** The Config field this row controls. */
  readonly key: keyof Config;
  /** Short human label shown in the list. */
  readonly label: string;
  /** One-line description shown below the label. */
  readonly description: string;
  /** Which prompt type to open on Enter. */
  readonly kind: RowKind;
  /** Options for `'select'` rows.  Undefined for `'input'` / `'confirm'`. */
  readonly options?: readonly SelectOption[];
  /**
   * Parse the raw string from an `'input'` prompt into the typed value.
   * Returns `null` to clear the field, or a typed value on success.
   * Returns a string on validation failure (the string becomes the inline
   * error message).
   */
  readonly parse?: (raw: string) => Config[keyof Config] | string;
}

/**
 * One row per user-configurable Config field.
 *
 * Order here is the display order in the settings panel.
 */
export const CONFIG_ROWS: readonly ConfigRow[] = [
  {
    key: 'aiProvider',
    label: 'AI Provider',
    description: 'Which AI CLI to drive',
    kind: 'select',
    options: [
      { value: 'claude', label: 'claude — Anthropic Claude Code CLI' },
      { value: 'copilot', label: 'copilot — GitHub Copilot CLI' },
    ],
  },
  {
    key: 'evaluationIterations',
    label: 'Eval Iterations',
    description: 'Max evaluator rounds per task (0 = disabled, default 1)',
    kind: 'input',
    parse: (raw: string): number | string => {
      const n = parseInt(raw.trim(), 10);
      if (isNaN(n) || n < 0) return 'Expected a non-negative integer (e.g. 0, 1, 2)';
      return n;
    },
  },
  {
    key: 'logLevel',
    label: 'Log Level',
    description: 'Filter log output level',
    kind: 'select',
    options: [
      { value: 'debug', label: 'debug — everything' },
      { value: 'info', label: 'info — default' },
      { value: 'warn', label: 'warn — warnings and errors only' },
      { value: 'error', label: 'error — errors only' },
    ],
  },
  {
    key: 'editor',
    label: 'Editor',
    description: 'Override editor for multi-line prompts (leave blank to clear)',
    kind: 'input',
    parse: (raw: string): string | null => (raw.trim() === '' ? null : raw.trim()),
  },
] as const;
