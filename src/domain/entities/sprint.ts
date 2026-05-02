import { Result } from 'typescript-result';

import { ConflictError } from '@src/domain/errors/conflict-error.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { ProjectName } from '@src/domain/values/project-name.ts';
import type { Slug } from '@src/domain/values/slug.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TicketId } from '@src/domain/values/ticket-id.ts';
import { ValidationError } from '@src/domain/values/validation-error.ts';
import type { Ticket } from './ticket.ts';

export type SprintStatus = 'draft' | 'active' | 'closed';

/** Construction inputs for {@link Sprint.create}. */
export interface SprintCreateInput {
  readonly id?: SprintId;
  readonly name: string;
  readonly slug: Slug;
  readonly now: IsoTimestamp;
  /**
   * Project this sprint targets. Sprint-per-project is the architectural
   * invariant — every ticket inside the sprint implicitly belongs to the
   * same project, and repo selection at planning time stores absolute
   * paths drawn from this project's repositories.
   */
  readonly projectName: ProjectName;
  /**
   * Repositories the sprint touches. Captured during `sprint plan` after
   * the user picks the affected repos via the checkbox UI. Defaults to an
   * empty list at creation time and is filled in via
   * {@link Sprint.setAffectedRepositories}.
   */
  readonly affectedRepositories?: readonly AbsolutePath[];
}

/**
 * `Sprint` — aggregate root containing the tickets users add during the
 * `draft` phase. Once `activated`, ticket edits are locked. Once `closed`,
 * everything is locked and `checkRanAt` is cleared.
 *
 * Mutators return new instances; the class is structurally immutable.
 * Lifecycle invariants live here, not at the use-case layer — the entity
 * is the single point that enforces them.
 */
export class Sprint {
  readonly id: SprintId;
  readonly name: string;
  readonly status: SprintStatus;
  readonly createdAt: IsoTimestamp;
  readonly activatedAt: IsoTimestamp | null;
  readonly closedAt: IsoTimestamp | null;
  readonly tickets: readonly Ticket[];
  readonly checkRanAt: ReadonlyMap<AbsolutePath, IsoTimestamp>;
  readonly branch: string | null;
  /**
   * Pull / merge request URL recorded after `sprint create-pr` runs.
   * `null` until the harness publishes a PR for the sprint branch.
   */
  readonly pullRequestUrl: string | null;
  /**
   * Project this sprint targets. Set at creation; never changes — moving
   * a sprint to a different project would break the planning artefacts
   * (task `projectPath`s, affected repos, etc.).
   */
  readonly projectName: ProjectName;
  /**
   * Repositories the sprint affects. Empty until `sprint plan` records the
   * user's repo selection; filled via {@link Sprint.setAffectedRepositories}.
   * Stored as absolute paths so downstream consumers (chain, prompt builder,
   * task executor) need no further resolution.
   */
  readonly affectedRepositories: readonly AbsolutePath[];

  private constructor(props: {
    id: SprintId;
    name: string;
    status: SprintStatus;
    createdAt: IsoTimestamp;
    activatedAt: IsoTimestamp | null;
    closedAt: IsoTimestamp | null;
    tickets: readonly Ticket[];
    checkRanAt: ReadonlyMap<AbsolutePath, IsoTimestamp>;
    branch: string | null;
    pullRequestUrl: string | null;
    projectName: ProjectName;
    affectedRepositories: readonly AbsolutePath[];
  }) {
    this.id = props.id;
    this.name = props.name;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.activatedAt = props.activatedAt;
    this.closedAt = props.closedAt;
    this.tickets = props.tickets;
    this.checkRanAt = props.checkRanAt;
    this.branch = props.branch;
    this.pullRequestUrl = props.pullRequestUrl;
    this.projectName = props.projectName;
    this.affectedRepositories = props.affectedRepositories;
  }

  static create(input: SprintCreateInput): Result<Sprint, ValidationError> {
    const name = input.name.trim();
    if (name.length === 0) {
      return Result.error(
        new ValidationError({
          field: 'sprint.name',
          value: input.name,
          message: 'sprint name must be a non-empty string',
        })
      );
    }
    const id = input.id ?? SprintId.create(new Date(input.now), input.slug);
    return Result.ok(
      new Sprint({
        id,
        name,
        status: 'draft',
        createdAt: input.now,
        activatedAt: null,
        closedAt: null,
        tickets: [],
        checkRanAt: new Map(),
        branch: null,
        pullRequestUrl: null,
        projectName: input.projectName,
        affectedRepositories: input.affectedRepositories ?? [],
      })
    );
  }

  // ───────────────────────── lifecycle ─────────────────────────

  activate(now: IsoTimestamp): Result<Sprint, InvalidStateError> {
    if (this.status !== 'draft') {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: this.status,
          attemptedAction: 'activate',
          hint: 'Only draft sprints can be activated. Check status with `ralphctl sprint show`.',
        })
      );
    }
    return Result.ok(this.with({ status: 'active', activatedAt: now }));
  }

  close(now: IsoTimestamp): Result<Sprint, InvalidStateError> {
    if (this.status !== 'active') {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: this.status,
          attemptedAction: 'close',
          hint: 'Only active sprints can be closed. Run `ralphctl sprint start` first.',
        })
      );
    }
    return Result.ok(
      this.with({
        status: 'closed',
        closedAt: now,
        checkRanAt: new Map<AbsolutePath, IsoTimestamp>(),
      })
    );
  }

  /**
   * Rename the sprint. Allowed in `draft` and `active`; rejected once the
   * sprint is `closed` (closed sprints are immutable). Validates the new
   * name with the same rules as {@link Sprint.create} (trimmed non-empty).
   */
  rename(newName: string): Result<Sprint, ValidationError | InvalidStateError> {
    if (this.status === 'closed') {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: this.status,
          attemptedAction: 'rename',
          hint: 'Closed sprints are immutable. Create a new sprint to continue work.',
        })
      );
    }
    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      return Result.error(
        new ValidationError({
          field: 'sprint.name',
          value: newName,
          message: 'sprint name must be a non-empty string',
        })
      );
    }
    return Result.ok(
      new Sprint({
        id: this.id,
        name: trimmed,
        status: this.status,
        createdAt: this.createdAt,
        activatedAt: this.activatedAt,
        closedAt: this.closedAt,
        tickets: this.tickets,
        checkRanAt: this.checkRanAt,
        branch: this.branch,
        pullRequestUrl: this.pullRequestUrl,
        projectName: this.projectName,
        affectedRepositories: this.affectedRepositories,
      })
    );
  }

  /**
   * Clear the working branch. Mirror of {@link Sprint.setBranch} with `null`
   * so callers can untrack a previously-committed branch (e.g. abandon a
   * sprint branch decision and re-prompt). Same lifecycle rule as setBranch:
   * rejected once `closed`.
   */
  clearBranch(): Result<Sprint, InvalidStateError> {
    if (this.status === 'closed') {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: this.status,
          attemptedAction: 'clear-branch',
        })
      );
    }
    return Result.ok(this.with({ branch: null }));
  }

  // ───────────────────────── tickets ─────────────────────────

  addTicket(ticket: Ticket): Result<Sprint, InvalidStateError | ConflictError> {
    if (this.status !== 'draft') {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: this.status,
          attemptedAction: 'add-ticket',
          hint: 'Tickets can only be added to draft sprints.',
        })
      );
    }
    if (this.tickets.some((t) => t.id === ticket.id)) {
      return Result.error(
        new ConflictError({
          entity: 'ticket',
          conflictingId: ticket.id,
          hint: 'A ticket with this id already exists. Use `ticket edit` to modify it.',
        })
      );
    }
    return Result.ok(this.with({ tickets: [...this.tickets, ticket] }));
  }

  removeTicket(id: TicketId): Result<Sprint, InvalidStateError> {
    if (this.status !== 'draft') {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: this.status,
          attemptedAction: 'remove-ticket',
          hint: 'Tickets can only be removed from draft sprints.',
        })
      );
    }
    const next = this.tickets.filter((t) => t.id !== id);
    return Result.ok(this.with({ tickets: next }));
  }

  replaceTicket(id: TicketId, updated: Ticket): Result<Sprint, InvalidStateError> {
    if (this.status !== 'draft') {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: this.status,
          attemptedAction: 'replace-ticket',
          hint: 'Tickets can only be edited on draft sprints.',
        })
      );
    }
    const next = this.tickets.map((t) => (t.id === id ? updated : t));
    return Result.ok(this.with({ tickets: next }));
  }

  // ───────────────────────── branch + checks ─────────────────────────

  /**
   * Set or change the working branch. Allowed in `draft` and `active`
   * (the user may pick a branch up-front or commit to one when execution
   * starts), but blocked once the sprint is `closed`.
   */
  setBranch(branch: string): Result<Sprint, InvalidStateError> {
    if (this.status === 'closed') {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: this.status,
          attemptedAction: 'set-branch',
        })
      );
    }
    return Result.ok(this.with({ branch }));
  }

  /**
   * Stamp a check-script run for one repo. Never fails — the harness owns
   * this audit trail and the entity should not gate it.
   */
  recordCheckRun(repo: AbsolutePath, at: IsoTimestamp): Sprint {
    const next = new Map(this.checkRanAt);
    next.set(repo, at);
    return this.with({ checkRanAt: next });
  }

  /**
   * Record the pull / merge request URL published for the sprint branch.
   * Allowed in any sprint status (closed sprints can still get a PR URL
   * recorded — legacy behavior). Validates `url` parses as a `URL` and uses
   * the `http`/`https` protocol; rejects empty / whitespace-only strings.
   */
  recordPullRequestUrl(url: string): Result<Sprint, ValidationError> {
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      return Result.error(
        new ValidationError({
          field: 'sprint.pullRequestUrl',
          value: url,
          message: 'pull request url must be a non-empty string',
        })
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return Result.error(
        new ValidationError({
          field: 'sprint.pullRequestUrl',
          value: url,
          message: 'pull request url must be a valid URL',
        })
      );
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return Result.error(
        new ValidationError({
          field: 'sprint.pullRequestUrl',
          value: url,
          message: 'pull request url must use http or https',
        })
      );
    }
    return Result.ok(this.with({ pullRequestUrl: trimmed }));
  }

  /**
   * Overwrite the affected-repositories list. Captured by `sprint plan`
   * after the user picks repos via the checkbox UI; idempotent so re-running
   * the planner overwrites a stale selection cleanly.
   *
   * Allowed in `draft` and `active` (the planner runs in `draft`; later
   * adjustments may need to land mid-execution). Blocked once `closed` —
   * affected repos are a planning artefact and closed sprints are immutable.
   */
  setAffectedRepositories(paths: readonly AbsolutePath[]): Result<Sprint, InvalidStateError> {
    if (this.status === 'closed') {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: this.status,
          attemptedAction: 'set-affected-repositories',
          hint: 'Closed sprints are immutable. Create a new sprint to continue work.',
        })
      );
    }
    return Result.ok(this.with({ affectedRepositories: [...paths] }));
  }

  // ───────────────────────── derivations ─────────────────────────

  /**
   * True iff every ticket in the sprint has reached `approved`.
   * Trivially true for an empty ticket list; callers that care about the
   * empty case should check `tickets.length` separately.
   */
  hasApprovedAllTickets(): boolean {
    return this.tickets.every((t) => t.requirementStatus === 'approved');
  }

  ticketById(id: TicketId): Ticket | undefined {
    return this.tickets.find((t) => t.id === id);
  }

  // ───────────────────────── internal ─────────────────────────

  private with(
    partial: Partial<{
      status: SprintStatus;
      activatedAt: IsoTimestamp | null;
      closedAt: IsoTimestamp | null;
      tickets: readonly Ticket[];
      checkRanAt: ReadonlyMap<AbsolutePath, IsoTimestamp>;
      branch: string | null;
      pullRequestUrl: string | null;
      affectedRepositories: readonly AbsolutePath[];
    }>
  ): Sprint {
    return new Sprint({
      id: this.id,
      name: this.name,
      status: partial.status ?? this.status,
      createdAt: this.createdAt,
      activatedAt: 'activatedAt' in partial ? (partial.activatedAt ?? null) : this.activatedAt,
      closedAt: 'closedAt' in partial ? (partial.closedAt ?? null) : this.closedAt,
      tickets: partial.tickets ?? this.tickets,
      checkRanAt: partial.checkRanAt ?? this.checkRanAt,
      branch: 'branch' in partial ? (partial.branch ?? null) : this.branch,
      pullRequestUrl: 'pullRequestUrl' in partial ? (partial.pullRequestUrl ?? null) : this.pullRequestUrl,
      projectName: this.projectName,
      affectedRepositories: partial.affectedRepositories ?? this.affectedRepositories,
    });
  }
}
