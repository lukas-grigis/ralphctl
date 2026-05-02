/**
 * Tiny fixture helpers shared across chain integration tests. Keep
 * deliberately small — a fixture is only worth promoting here once two
 * chain test files would otherwise duplicate the same boilerplate.
 *
 * Everything throws on validation failure: tests are programmer-controlled
 * inputs, and a fixture failing means the test author got the inputs
 * wrong, not that production code has a bug.
 */
import { Project } from '@src/domain/entities/project.ts';
import { Repository } from '@src/domain/entities/repository.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { Task } from '@src/domain/entities/task.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { TaskId } from '@src/domain/values/task-id.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';

export const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;
export const T1 = '2026-04-29T15:00:00.000Z' as IsoTimestamp;

function unwrap<T>(r: { ok: boolean; value?: T; error?: unknown }, label: string): T {
  if (!r.ok) {
    const err = r.error;
    throw new Error(`${label}: precondition failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return r.value as T;
}

export function slug(s: string): Slug {
  return unwrap(Slug.parse(s), `slug(${s})`);
}

export function projectName(s: string): ProjectName {
  return unwrap(ProjectName.parse(s), `projectName(${s})`);
}

export function abs(p: string): AbsolutePath {
  return unwrap(AbsolutePath.parse(p), `abs(${p})`);
}

export function makeSprint(
  opts: {
    readonly name?: string;
    readonly slug?: string;
    readonly now?: IsoTimestamp;
    readonly projectName?: string;
  } = {}
): Sprint {
  return unwrap(
    Sprint.create({
      name: opts.name ?? 'Sprint A',
      slug: slug(opts.slug ?? 'a'),
      now: opts.now ?? T0,
      projectName: projectName(opts.projectName ?? 'demo'),
    }),
    'makeSprint'
  );
}

export function makeTicket(
  opts: {
    readonly title?: string;
    readonly id?: TicketId;
  } = {}
): Ticket {
  return unwrap(
    Ticket.create({
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      title: opts.title ?? 'A ticket',
    }),
    'makeTicket'
  );
}

export function makeApprovedTicket(
  opts: {
    readonly title?: string;
    readonly requirements?: string;
    readonly id?: TicketId;
  } = {}
): Ticket {
  const t = makeTicket(opts);
  return unwrap(t.approveRequirements(opts.requirements ?? 'requirements'), 'approve');
}

export function makeProject(
  opts: {
    readonly name?: string;
    readonly displayName?: string;
    readonly repoPath?: string;
  } = {}
): Project {
  const repo = unwrap(
    Repository.create({
      path: abs(opts.repoPath ?? '/tmp/demo-repo'),
      name: 'demo-repo',
    }),
    'makeProject:repo'
  );
  return unwrap(
    Project.create({
      name: projectName(opts.name ?? 'demo'),
      displayName: opts.displayName ?? 'Demo',
      repositories: [repo],
    }),
    'makeProject'
  );
}

export function makeTask(
  opts: {
    readonly id?: TaskId;
    readonly name?: string;
    readonly order?: number;
    readonly projectPath?: string;
    readonly blockedBy?: readonly TaskId[];
    readonly ticketId?: TicketId;
  } = {}
): Task {
  return unwrap(
    Task.create({
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      name: opts.name ?? 'Task',
      steps: ['do thing'],
      verificationCriteria: ['it works'],
      order: opts.order ?? 1,
      projectPath: abs(opts.projectPath ?? '/tmp/demo-repo'),
      ...(opts.blockedBy !== undefined ? { blockedBy: opts.blockedBy } : {}),
      ...(opts.ticketId !== undefined ? { ticketId: opts.ticketId } : {}),
    }),
    'makeTask'
  );
}

export function sprintId(literal: string): SprintId {
  return SprintId.trustString(literal);
}

export function taskId(literal: string): TaskId {
  return TaskId.trustString(literal);
}

export function ticketId(literal: string): TicketId {
  return TicketId.trustString(literal);
}
