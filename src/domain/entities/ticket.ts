import { Result } from 'typescript-result';

import { InvalidStateError } from '../errors/invalid-state-error.ts';
import type { AbsolutePath } from '../values/absolute-path.ts';
import type { ProjectName } from '../values/project-name.ts';
import { TicketId } from '../values/ticket-id.ts';
import { ValidationError } from '../values/validation-error.ts';

/**
 * Lifecycle of a ticket's requirements: starts `pending`, transitions once
 * to `approved` after the human-in-the-loop refinement step. Approval is
 * the gate that lets `sprint plan` consume the ticket.
 */
export type RequirementStatus = 'pending' | 'approved';

/** Construction inputs for {@link Ticket.create}. */
export interface TicketCreateInput {
  readonly id?: TicketId;
  readonly title: string;
  readonly description?: string;
  readonly link?: string;
  readonly projectName: ProjectName;
}

/**
 * `Ticket` — a unit of intent that lives inside a `Sprint`. Tickets are
 * nested entities; they do not have their own repository (mutate via
 * `SprintRepository.save`).
 *
 * All state transitions return new instances; the class is structurally
 * immutable. Construction validates input invariants (non-empty title,
 * URL-shaped link if provided); state transitions enforce the lifecycle
 * (e.g. cannot re-approve once approved).
 */
export class Ticket {
  readonly id: TicketId;
  readonly title: string;
  readonly description: string | undefined;
  readonly link: string | undefined;
  readonly projectName: ProjectName;
  readonly affectedRepositories: readonly AbsolutePath[] | undefined;
  readonly requirementStatus: RequirementStatus;
  readonly requirements: string | undefined;

  private constructor(props: {
    id: TicketId;
    title: string;
    description: string | undefined;
    link: string | undefined;
    projectName: ProjectName;
    affectedRepositories: readonly AbsolutePath[] | undefined;
    requirementStatus: RequirementStatus;
    requirements: string | undefined;
  }) {
    this.id = props.id;
    this.title = props.title;
    this.description = props.description;
    this.link = props.link;
    this.projectName = props.projectName;
    this.affectedRepositories = props.affectedRepositories;
    this.requirementStatus = props.requirementStatus;
    this.requirements = props.requirements;
  }

  static create(input: TicketCreateInput): Result<Ticket, ValidationError> {
    const title = input.title.trim();
    if (title.length === 0) {
      return Result.error(
        new ValidationError({
          field: 'ticket.title',
          value: input.title,
          message: 'ticket title must be a non-empty string',
        })
      );
    }

    let link: string | undefined;
    if (input.link !== undefined) {
      const candidate = input.link.trim();
      if (candidate.length === 0 || !isValidUrl(candidate)) {
        return Result.error(
          new ValidationError({
            field: 'ticket.link',
            value: input.link,
            message: 'ticket link must be a valid URL when provided',
            hint: 'e.g. https://github.com/owner/repo/issues/42',
          })
        );
      }
      link = candidate;
    }

    const description = input.description?.trim();
    return Result.ok(
      new Ticket({
        id: input.id ?? TicketId.generate(),
        title,
        description: description !== undefined && description.length > 0 ? description : undefined,
        link,
        projectName: input.projectName,
        affectedRepositories: undefined,
        requirementStatus: 'pending',
        requirements: undefined,
      })
    );
  }

  /**
   * Move from `pending` to `approved`, capturing the refined requirements
   * text. Re-approval is a programmer error — the caller should be reading
   * the current status before invoking.
   */
  approveRequirements(text: string): Result<Ticket, InvalidStateError> {
    if (this.requirementStatus !== 'pending') {
      return Result.error(
        new InvalidStateError({
          entity: 'ticket',
          currentState: this.requirementStatus,
          attemptedAction: 'approve-requirements',
        })
      );
    }
    return Result.ok(
      this.with({
        requirementStatus: 'approved',
        requirements: text,
      })
    );
  }

  /**
   * Overwrite the affected-repositories list. Idempotent — the planner
   * may re-run the selection step and we want the latest answer to win.
   */
  assignRepositories(paths: readonly AbsolutePath[]): Ticket {
    return this.with({ affectedRepositories: [...paths] });
  }

  private with(
    partial: Partial<{
      title: string;
      description: string | undefined;
      link: string | undefined;
      affectedRepositories: readonly AbsolutePath[] | undefined;
      requirementStatus: RequirementStatus;
      requirements: string | undefined;
    }>
  ): Ticket {
    return new Ticket({
      id: this.id,
      title: partial.title ?? this.title,
      description: 'description' in partial ? partial.description : this.description,
      link: 'link' in partial ? partial.link : this.link,
      projectName: this.projectName,
      affectedRepositories:
        'affectedRepositories' in partial ? partial.affectedRepositories : this.affectedRepositories,
      requirementStatus: partial.requirementStatus ?? this.requirementStatus,
      requirements: 'requirements' in partial ? partial.requirements : this.requirements,
    });
  }
}

function isValidUrl(s: string): boolean {
  try {
    // URL constructor throws on malformed input; presence of a protocol is
    // implicit (relative URLs need a base, and we want absolute URLs only).
    new URL(s);
    return true;
  } catch {
    return false;
  }
}
