import type { Config, ImportTask, Project, Sprint, Task, Ticket } from '@src/domain/models.ts';

/** Port for all data persistence operations */
export interface PersistencePort {
  // Sprint

  /** Retrieve a sprint by ID */
  getSprint(id: string): Promise<Sprint>;

  /** Persist a sprint (create or update) */
  saveSprint(sprint: Sprint): Promise<void>;

  /** List all sprints */
  listSprints(): Promise<Sprint[]>;

  /** Create a new draft sprint with optional name */
  createSprint(name?: string): Promise<Sprint>;

  /** Resolve a sprint ID, falling back to the current sprint */
  resolveSprintId(id?: string): Promise<string>;

  /** Activate a draft sprint (sets status to active) */
  activateSprint(id: string): Promise<Sprint>;

  /** Close an active sprint */
  closeSprint(id: string): Promise<Sprint>;

  // Tasks

  /** Get all tasks for a sprint */
  getTasks(sprintId: string): Promise<Task[]>;

  /** Persist the full task list for a sprint */
  saveTasks(tasks: Task[], sprintId: string): Promise<void>;

  /** Get a single task by ID within a sprint */
  getTask(id: string, sprintId: string): Promise<Task>;

  /** Update a task's status and return the updated task */
  updateTaskStatus(id: string, status: string, sprintId: string): Promise<Task>;

  /** List all tasks for a sprint (alias for getTasks) */
  listTasks(sprintId: string): Promise<Task[]>;

  /** Reorder tasks by their dependency graph */
  reorderByDependencies(sprintId: string): Promise<void>;

  /** Validate import tasks against existing tasks and ticket IDs, returning error messages */
  validateImportTasks(tasks: ImportTask[], existingTasks: Task[], ticketIds: Set<string>): string[];

  /** Import tasks into a sprint, optionally replacing all existing tasks */
  importTasks(tasks: ImportTask[], sprintId: string, options?: { replace?: boolean }): Promise<number>;

  /** Get the next ready task (in_progress first, then todo with deps met) */
  getNextTask(sprintId: string): Promise<Task | null>;

  /** Get all tasks ready for execution (todo with deps met) */
  getReadyTasks(sprintId: string): Promise<Task[]>;

  /** Get remaining (non-done) tasks */
  getRemainingTasks(sprintId: string): Promise<Task[]>;

  /** Check if all tasks in the sprint are done */
  areAllTasksDone(sprintId: string): Promise<boolean>;

  /** Update arbitrary fields on a task */
  updateTask(id: string, updates: Partial<Task>, sprintId: string): Promise<void>;

  // Tickets

  /** Get a single ticket by ID within a sprint */
  getTicket(id: string, sprintId: string): Promise<Ticket>;

  // Projects

  /** Get a project by name */
  getProject(name: string): Promise<Project>;

  /** List all projects */
  listProjects(): Promise<Project[]>;

  // Config

  /** Get the global config */
  getConfig(): Promise<Config>;

  /** Persist the global config */
  saveConfig(config: Config): Promise<void>;

  // Progress

  /** Append a progress log message */
  logProgress(message: string, options?: { sprintId?: string; projectPath?: string }): Promise<void>;

  /** Read the full progress log for a sprint */
  getProgress(sprintId: string): Promise<string>;

  /**
   * Read the progress log, filter it to entries matching `projectPath`, and
   * return a compressed summary of the last `maxEntries` entries (default 3)
   * suitable for embedding in a task-context file. Returns `''` when there
   * is no project-matching progress yet.
   */
  getProgressSummary(sprintId: string, projectPath: string, maxEntries?: number): Promise<string>;

  // Evaluation

  /** Write an evaluation sidecar entry for a task */
  writeEvaluation(sprintId: string, taskId: string, iteration: number, status: string, body: string): Promise<void>;
}
