import { Result } from '@src/domain/result.ts';
import { attachTicketLink, type Sprint } from '@src/domain/entity/sprint.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';

/**
 * Structural match for the SCM `IssuePusher` port. Ticket must not import `business/scm`
 * (sibling isolation); callers pass the real port and TypeScript accepts it by shape.
 */
export interface PublishTracker {
  resolveOrigin(cwd: AbsolutePath): Promise<Result<unknown, StorageError>>;
  create(args: {
    readonly cwd: AbsolutePath;
    readonly title: string;
    readonly body: string;
  }): Promise<Result<{ url: string }, StorageError>>;
  listComments(url: string): Promise<Result<readonly string[], StorageError>>;
  comment(url: string, args: { readonly body: string }): Promise<Result<void, StorageError>>;
}

export type PublishTicketToTrackerOutcome = 'created' | 'commented' | 'already-up-to-date' | 'nothing-to-post';

export interface PublishTicketToTrackerProps {
  readonly sprint: Sprint;
  readonly ticketId: TicketId;
  readonly cwd: AbsolutePath;
  readonly issuePusher: PublishTracker;
}

export interface PublishTicketToTrackerOutput {
  readonly sprint: Sprint;
  readonly outcome: PublishTicketToTrackerOutcome;
}

export type PublishTicketToTrackerError = NotFoundError | ValidationError | StorageError;

const REFINEMENT_MARKER = '<!-- ralphctl:refined-requirements -->';

/** Same bytes as `refinementCommentBody` in business/scm — ticket cannot import that sibling. */
const refinementBody = (requirements: string): string => `${requirements}\n\n${REFINEMENT_MARKER}`;

/**
 * Create the ticket on the cwd's origin tracker, or post an idempotent refinement comment
 * on an existing link. Pure: never saves. Origin is always `issuePusher.resolveOrigin(cwd)`
 * — `Project.defaultIssueOrigin` is not consulted.
 */
export const publishTicketToTracker = async (
  props: PublishTicketToTrackerProps
): Promise<Result<PublishTicketToTrackerOutput, PublishTicketToTrackerError>> => {
  const ticket = props.sprint.tickets.find((t) => t.id === props.ticketId);
  if (ticket === undefined) {
    return Result.error(new NotFoundError({ entity: 'ticket', id: String(props.ticketId) }));
  }

  if (ticket.link !== undefined) {
    return publishExistingLink(props, ticket.link, ticket.status === 'approved' ? ticket.requirements : undefined);
  }

  const title = parseRequiredString('ticket.title', ticket.title);
  if (!title.ok) return Result.error(title.error);

  const origin = await props.issuePusher.resolveOrigin(props.cwd);
  if (!origin.ok) return Result.error(origin.error);
  if (origin.value === null) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `no GitHub or GitLab origin at ${String(props.cwd)}`,
      })
    );
  }

  const created = await props.issuePusher.create({
    cwd: props.cwd,
    title: title.value,
    body: ticket.description ?? '',
  });
  if (!created.ok) return Result.error(created.error);

  const attached = attachTicketLink(props.sprint, props.ticketId, created.value.url);
  if (!attached.ok) return Result.error(attached.error);
  return Result.ok({ sprint: attached.value, outcome: 'created' });
};

const publishExistingLink = async (
  props: PublishTicketToTrackerProps,
  link: string,
  requirements: string | undefined
): Promise<Result<PublishTicketToTrackerOutput, PublishTicketToTrackerError>> => {
  if (requirements === undefined) {
    return Result.ok({ sprint: props.sprint, outcome: 'nothing-to-post' });
  }

  const body = refinementBody(requirements);
  const listed = await props.issuePusher.listComments(link);
  if (!listed.ok) return Result.error(listed.error);
  if (listed.value.includes(body)) {
    return Result.ok({ sprint: props.sprint, outcome: 'already-up-to-date' });
  }

  const posted = await props.issuePusher.comment(link, { body });
  if (!posted.ok) return Result.error(posted.error);
  return Result.ok({ sprint: props.sprint, outcome: 'commented' });
};
