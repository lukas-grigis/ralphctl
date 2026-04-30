/**
 * PromptPort — primitive interactive prompts used by commands and adapters.
 *
 * Lives in business/ports so both integration/ (the Ink adapter) and
 * application/ (the composition root + CLI commands) can import it.
 *
 * Cancellation semantics:
 * - `select` / `confirm` / `input` / `checkbox` throw `PromptCancelledError`
 *   on Ctrl+C or Escape.
 * - `editor` / `fileBrowser` return `null` on cancel — these are flows where
 *   "I changed my mind" is a common, non-error path.
 *
 * Implementation: `InkPromptAdapter` in `integration/ui/prompts/`.
 */

export class PromptCancelledError extends Error {
  constructor(message = 'Prompt cancelled by user') {
    super(message);
    this.name = 'PromptCancelledError';
  }
}

export interface PromptChoice<T> {
  label: string;
  value: T;
  description?: string;
  disabled?: boolean | string;
}

export interface SelectOptions<T> {
  message: string;
  choices: PromptChoice<T>[];
  default?: T;
}

export interface ConfirmOptions {
  message: string;
  default?: boolean;
  /**
   * Optional multi-line block rendered above the Y/n line (e.g. a preview
   * the user is approving).
   */
  details?: string;
}

export interface InputOptions {
  message: string;
  default?: string;
  validate?: (value: string) => true | string | Promise<true | string>;
}

export interface CheckboxOptions<T> {
  message: string;
  choices: PromptChoice<T>[];
  /** Default-selected values. If omitted, none are preselected. */
  defaults?: T[];
}

export interface EditorOptions {
  message: string;
  default?: string;
  /** Hint for rendering (e.g. "markdown"). Reserved for future syntax highlighting. */
  kind?: 'plain' | 'markdown';
}

export interface FileBrowserOptions {
  startPath: string;
  /** Only allow selecting directories that are git repositories. */
  mustBeGitRepo?: boolean;
  /** Prompt message shown at the top of the browser. */
  message?: string;
}

export interface PromptPort {
  select<T>(options: SelectOptions<T>): Promise<T>;
  confirm(options: ConfirmOptions): Promise<boolean>;
  input(options: InputOptions): Promise<string>;
  checkbox<T>(options: CheckboxOptions<T>): Promise<T[]>;
  editor(options: EditorOptions): Promise<string | null>;
  fileBrowser(options: FileBrowserOptions): Promise<string | null>;
}
