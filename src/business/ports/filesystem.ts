/** Port for filesystem operations needed by business logic */
export interface FilesystemPort {
  /** Ensure a directory exists, creating it recursively if needed */
  ensureDir(path: string): Promise<void>;

  /** Read a file as a UTF-8 string */
  readFile(path: string): Promise<string>;

  /** Write a string to a file, creating parent directories as needed */
  writeFile(path: string, content: string): Promise<void>;

  /** Delete a file; a no-op if the file does not exist. */
  deleteFile(path: string): Promise<void>;

  /** Check if a file exists */
  fileExists(path: string): Promise<boolean>;

  /** Get the refinement directory for a ticket */
  getRefinementDir(sprintId: string, ticketId: string): string;

  /** Get the planning directory for a sprint */
  getPlanningDir(sprintId: string): string;

  /** Get the ideation directory for a ticket */
  getIdeationDir(sprintId: string, ticketId: string): string;

  /** Get the sprint directory */
  getSprintDir(sprintId: string): string;

  /** Get the absolute path to the sprint's append-only progress log. */
  getProgressFilePath(sprintId: string): string;

  /**
   * Get the absolute path to the per-task context file that lives inside
   * the PROJECT directory (not the sprint directory). The agent's prompt
   * references this by its basename so `{{CONTEXT_FILE}}` resolves against
   * the cwd the AI CLI runs in.
   */
  getProjectContextFilePath(projectPath: string, sprintId: string, taskId: string): string;
}
