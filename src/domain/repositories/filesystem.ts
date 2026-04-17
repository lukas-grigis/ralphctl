/** Port for filesystem operations needed by business logic */
export interface FilesystemPort {
  /** Ensure a directory exists, creating it recursively if needed */
  ensureDir(path: string): Promise<void>;

  /** Read a file as a UTF-8 string */
  readFile(path: string): Promise<string>;

  /** Write a string to a file, creating parent directories as needed */
  writeFile(path: string, content: string): Promise<void>;

  /** Check if a file exists */
  fileExists(path: string): Promise<boolean>;

  /** Get the refinement directory for a ticket */
  getRefinementDir(sprintId: string, ticketId: string): string;

  /** Get the planning directory for a sprint */
  getPlanningDir(sprintId: string): string;

  /** Get the sprint directory */
  getSprintDir(sprintId: string): string;

  /** Get the absolute path to a JSON schema file */
  getSchemaPath(name: string): string;
}
