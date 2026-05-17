import { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { requireStatus } from '@src/domain/value/require-status.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { createSprintExecution, type SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';

/**
 * Planning aggregate. Holds identity, lifecycle, and the ticket set. Delivery / execution
 * concerns (branch, PR url, setup-script audit, affected-repo selection) live in the sibling
 * `SprintExecution` aggregate, paired 1:1 by `SprintId`.
 *
 * Lifecycle stamps (`plannedAt`, `activatedAt`, `reviewAt`, `doneAt`) mark explicit state
 * transitions. There is no separate audit `createdAt`/`updatedAt`/`version` — the lifecycle
 * stamps are the only timing the codebase actually consumes.
 */
interface SprintBase extends Entity<SprintId> {
  /** Kebab-case CLI handle. Unique within a project; renamable without breaking refs. */
  readonly slug: Slug;
  readonly name: string;
  readonly tickets: readonly Ticket[];
  /** Project this sprint targets. Set at creation, never changes. */
  readonly projectId: ProjectId;
}

/** Tickets are still being edited and refined. */
export interface DraftSprint extends SprintBase {
  readonly status: 'draft';
  readonly plannedAt: null;
  readonly activatedAt: null;
  readonly reviewAt: null;
  readonly doneAt: null;
}

/** Every ticket is approved and tasks have been generated; ready to activate. */
export interface PlannedSprint extends SprintBase {
  readonly status: 'planned';
  readonly plannedAt: IsoTimestamp;
  readonly activatedAt: null;
  readonly reviewAt: null;
  readonly doneAt: null;
}

export interface ActiveSprint extends SprintBase {
  readonly status: 'active';
  readonly plannedAt: IsoTimestamp;
  readonly activatedAt: IsoTimestamp;
  readonly reviewAt: null;
  readonly doneAt: null;
}

/**
 * Implementation finished — every task is done or blocked. The sprint is open for human
 * review: operator inspects the work, optionally drives feedback rounds via
 * `apply-feedback`, then transitions to `done`. The aggregate is still mutable in this
 * state — the review chain may produce additional commits.
 */
export interface ReviewSprint extends SprintBase {
  readonly status: 'review';
  readonly plannedAt: IsoTimestamp;
  readonly activatedAt: IsoTimestamp;
  readonly reviewAt: IsoTimestamp;
  readonly doneAt: null;
}

/** Terminal state — review accepted, sprint sealed. */
export interface DoneSprint extends SprintBase {
  readonly status: 'done';
  readonly plannedAt: IsoTimestamp;
  readonly activatedAt: IsoTimestamp;
  readonly reviewAt: IsoTimestamp;
  readonly doneAt: IsoTimestamp;
}

export type Sprint = DraftSprint | PlannedSprint | ActiveSprint | ReviewSprint | DoneSprint;

/** Convenience union for all non-terminal states (everything but `done`). */
export type OpenSprint = DraftSprint | PlannedSprint | ActiveSprint | ReviewSprint;

/** Derived from `Sprint` — adding a new variant flows here automatically. */
export type SprintStatus = Sprint['status'];

export interface SprintCreateInput {
  readonly id?: SprintId;
  readonly name: string;
  /** Optional. Defaults to `kebab-case(name)` when omitted. */
  readonly slug?: Slug;
  readonly projectId: ProjectId;
}

const sprintBaseFrom = (sprint: Sprint): SprintBase => ({
  id: sprint.id,
  slug: sprint.slug,
  name: sprint.name,
  tickets: sprint.tickets,
  projectId: sprint.projectId,
});

/**
 * Create a draft sprint. Most callers should prefer {@link createSprintWithExecution}, which
 * also produces the paired `SprintExecution` so the two cannot be persisted independently —
 * an orphan Sprint without execution is a structural bug. This standalone constructor stays
 * public because codecs need it for rehydration from disk.
 */
export const createSprint = (input: SprintCreateInput): Result<DraftSprint, ValidationError> => {
  const name = parseRequiredString('sprint.name', input.name);
  if (!name.ok) return Result.error(name.error);

  const slug = resolveSlug(input.slug, name.value);
  if (!slug.ok) return Result.error(slug.error);

  return Result.ok({
    id: input.id ?? SprintId.generate(),
    slug: slug.value,
    name: name.value,
    status: 'draft',
    plannedAt: null,
    activatedAt: null,
    reviewAt: null,
    doneAt: null,
    tickets: [],
    projectId: input.projectId,
  });
};

const resolveSlug = (candidate: Slug | undefined, name: string): Result<Slug, ValidationError> => {
  if (candidate !== undefined) return Result.ok(candidate);
  const derived = toKebabCase(name);
  if (derived.length === 0) {
    return Result.error(
      new ValidationError({
        field: 'sprint.slug',
        value: name,
        message: `could not derive slug from name '${name}'`,
        hint: 'pass an explicit slug',
      })
    );
  }
  return Slug.parse(derived);
};

/**
 * Create a draft sprint AND its paired `SprintExecution` atomically. Use this in business
 * code so the two cannot be persisted independently — the harness assumes both exist.
 */
export const createSprintWithExecution = (
  input: SprintCreateInput
): Result<{ readonly sprint: DraftSprint; readonly execution: SprintExecution }, ValidationError> => {
  const sprintResult = createSprint(input);
  if (!sprintResult.ok) return Result.error(sprintResult.error);
  const sprint = sprintResult.value;
  const execution = createSprintExecution({ sprintId: sprint.id });
  return Result.ok({ sprint, execution });
};

// ───────────────────────── lifecycle ─────────────────────────

/**
 * Transition `draft → planned`. Caller is responsible for generating + persisting tasks
 * via `TaskRepository.saveAll`; this function only flips the sprint state.
 *
 * Rejects if any ticket is still pending refinement, or if there are no tickets at all.
 */
export const planSprint = (sprint: Sprint, now: IsoTimestamp): Result<PlannedSprint, InvalidStateError> => {
  const guard = requireStatus('sprint', sprint, ['draft'] as const, 'plan', 'Only draft sprints can be planned.');
  if (!guard.ok) return Result.error(guard.error);
  const draft = guard.value;
  if (draft.tickets.length === 0) {
    return Result.error(
      new InvalidStateError({
        entity: 'sprint',
        currentState: 'draft',
        attemptedAction: 'plan',
        message: `cannot plan sprint '${draft.id}': no tickets have been added`,
        hint: 'Add at least one ticket before planning the sprint.',
      })
    );
  }
  const pending = draft.tickets.find((t) => t.status === 'pending');
  if (pending !== undefined) {
    return Result.error(
      new InvalidStateError({
        entity: 'sprint',
        currentState: 'draft',
        attemptedAction: 'plan',
        message: `cannot plan sprint '${draft.id}': ticket '${pending.id}' has unapproved requirements`,
        hint: 'Run `ticket refine` on every pending ticket before planning the sprint.',
      })
    );
  }
  return Result.ok({
    ...sprintBaseFrom(draft),
    status: 'planned',
    plannedAt: now,
    activatedAt: null,
    reviewAt: null,
    doneAt: null,
  });
};

export const activateSprint = (sprint: Sprint, now: IsoTimestamp): Result<ActiveSprint, InvalidStateError> => {
  const guard = requireStatus(
    'sprint',
    sprint,
    ['planned'] as const,
    'activate',
    'Only planned sprints can be activated.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const planned = guard.value;
  return Result.ok({
    ...sprintBaseFrom(planned),
    status: 'active',
    plannedAt: planned.plannedAt,
    activatedAt: now,
    reviewAt: null,
    doneAt: null,
  });
};

/**
 * Transition `active → review`. Called by the implement chain's `transition-sprint-to-review`
 * leaf after every task has settled (done or blocked). The sprint stays mutable for the
 * duration of the review chain — apply-feedback rounds may produce more commits.
 */
export const transitionSprintToReview = (
  sprint: Sprint,
  now: IsoTimestamp
): Result<ReviewSprint, InvalidStateError> => {
  const guard = requireStatus(
    'sprint',
    sprint,
    ['active'] as const,
    'transition-to-review',
    'Only active sprints can transition to review.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const active = guard.value;
  return Result.ok({
    ...sprintBaseFrom(active),
    status: 'review',
    plannedAt: active.plannedAt,
    activatedAt: active.activatedAt,
    reviewAt: now,
    doneAt: null,
  });
};

/**
 * Transition `review → done`. Called by the review chain's `transition-sprint-to-done` leaf
 * after the user signals "done" via the empty / repeat termination round in `feedback.md`.
 * Terminal state — no further transitions, no further mutations.
 */
export const transitionSprintToDone = (sprint: Sprint, now: IsoTimestamp): Result<DoneSprint, InvalidStateError> => {
  const guard = requireStatus(
    'sprint',
    sprint,
    ['review'] as const,
    'transition-to-done',
    'Only review sprints can transition to done.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const review = guard.value;
  return Result.ok({
    ...sprintBaseFrom(review),
    status: 'done',
    plannedAt: review.plannedAt,
    activatedAt: review.activatedAt,
    reviewAt: review.reviewAt,
    doneAt: now,
  });
};

/** Allowed in any non-terminal status; rejected once `done`. */
export const renameSprint = (
  sprint: Sprint,
  newName: string
): Result<OpenSprint, ValidationError | InvalidStateError> => {
  const guard = requireStatus(
    'sprint',
    sprint,
    ['draft', 'planned', 'active', 'review'] as const,
    'rename',
    'Done sprints are immutable.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const name = parseRequiredString('sprint.name', newName);
  if (!name.ok) return Result.error(name.error);
  return Result.ok({ ...guard.value, name: name.value });
};

// ───────────────────────── tickets ─────────────────────────

export const addTicket = (sprint: Sprint, ticket: Ticket): Result<DraftSprint, InvalidStateError | ConflictError> => {
  const guard = requireStatus(
    'sprint',
    sprint,
    ['draft'] as const,
    'add-ticket',
    'Tickets can only be added to draft sprints.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const draft = guard.value;
  if (draft.tickets.some((t) => t.id === ticket.id)) {
    return Result.error(
      new ConflictError({
        entity: 'ticket',
        field: 'id',
        value: ticket.id,
        hint: 'A ticket with this id already exists. Use `ticket edit` to modify it.',
      })
    );
  }
  return Result.ok({ ...draft, tickets: [...draft.tickets, ticket] });
};

export const removeTicket = (sprint: Sprint, id: TicketId): Result<DraftSprint, InvalidStateError> => {
  const guard = requireStatus(
    'sprint',
    sprint,
    ['draft'] as const,
    'remove-ticket',
    'Tickets can only be removed from draft sprints.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const draft = guard.value;
  return Result.ok({ ...draft, tickets: draft.tickets.filter((t) => t.id !== id) });
};

export const replaceTicket = (
  sprint: Sprint,
  id: TicketId,
  updated: Ticket
): Result<DraftSprint, InvalidStateError> => {
  const guard = requireStatus(
    'sprint',
    sprint,
    ['draft'] as const,
    'replace-ticket',
    'Tickets can only be edited on draft sprints.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const draft = guard.value;
  return Result.ok({ ...draft, tickets: draft.tickets.map((t) => (t.id === id ? updated : t)) });
};

// ───────────────────────── derivations ─────────────────────────

/**
 * Guard: assert the sprint is in one of the allowed statuses. Returns ok when satisfied,
 * `InvalidStateError` with the structured detail when not. Used by chain guard leaves to
 * gate flow entry (`'planned'|'active'` for implement, `'draft'` for add-tickets, etc.).
 */
export const assertSprintStatus = (
  sprint: Sprint,
  allowed: readonly SprintStatus[],
  attemptedAction: string
): Result<Sprint, InvalidStateError> => {
  if (allowed.includes(sprint.status)) return Result.ok(sprint);
  return Result.error(
    new InvalidStateError({
      entity: 'sprint',
      currentState: sprint.status,
      attemptedAction,
      message: `cannot ${attemptedAction} on sprint in '${sprint.status}' status — allowed: ${allowed.join(', ')}`,
    })
  );
};
