import type { Repository } from '@src/domain/models.ts';

/** Port for user interaction during workflows */
export interface UserInteractionPort {
  /** Ask user for confirmation. Optional `details` is a multi-line block rendered above the Y/n line. */
  confirm(message: string, defaultValue?: boolean, details?: string): Promise<boolean>;

  /** Let user select repository paths from grouped options */
  selectPaths(reposByProject: Map<string, Repository[]>, message: string, preselected?: string[]): Promise<string[]>;

  /** Prompt user to select a branch strategy. Returns 'auto' name, 'keep' (null), or custom name. */
  selectBranchStrategy(sprintId: string, autoName: string): Promise<string | null>;

  /** Prompt user for free-form feedback. Returns null if user approves (no feedback). */
  getFeedback(message: string): Promise<string | null>;
}
