/**
 * `NotFoundError` — raised when a repository or aggregate lookup cannot
 * resolve the requested identifier.
 *
 * Examples:
 *  - `SprintRepository.findById(id)` for an unknown sprint id
 *  - `ProjectRepository.findByName(name)` for an unregistered project
 *  - `TaskRepository.findById(sprintId, taskId)` for a missing task
 *
 * Carries the logical entity name + the unfound id so diagnostics can
 * render a precise message without re-deriving the shape from the human
 * `message`.
 *
 * Structurally compatible with the kernel's `KernelError` shape
 * (`{ code, message, cause? }`) so chain elements can propagate it without
 * translation.
 */
export interface NotFoundErrorOptions {
  readonly entity: string;
  readonly id: string;
  readonly message?: string;
  /** Optional human-readable repair hint. */
  readonly hint?: string;
}

export class NotFoundError extends Error {
  /** Discriminator. `as const` keeps it narrow at the type level. */
  readonly code = 'not-found' as const;
  /** Logical entity name (e.g. "sprint", "project", "task", "ticket"). */
  readonly entity: string;
  /** The identifier that was not found. */
  readonly id: string;
  /** Optional human-readable repair hint. */
  readonly hint?: string;

  constructor(opts: NotFoundErrorOptions) {
    super(opts.message ?? `${opts.entity} '${opts.id}' not found`);
    this.name = 'NotFoundError';
    this.entity = opts.entity;
    this.id = opts.id;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
