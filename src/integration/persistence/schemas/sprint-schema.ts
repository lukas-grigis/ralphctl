import { z } from 'zod';

import { Sprint } from '@src/domain/entities/sprint.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';

const sprintStatusSchema = z.enum(['draft', 'active', 'closed']);
const requirementStatusSchema = z.enum(['pending', 'approved']);

const ticketJsonSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  link: z.string().optional(),
  requirementStatus: requirementStatusSchema,
  requirements: z.string().optional(),
});

export type TicketJson = z.infer<typeof ticketJsonSchema>;

/** On-disk shape of a sprint with its nested tickets. */
export const sprintJsonSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: sprintStatusSchema,
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  branch: z.string().nullable(),
  // Backwards-compat: legacy `sprint.json` files predate this field. Default
  // to `null` on read so existing files keep loading; new writes always
  // emit it explicitly.
  pullRequestUrl: z.string().nullable().optional().default(null),
  // Sprint-per-project — every sprint targets exactly one project. Required;
  // old-shape JSON without this key fails schema validation by design.
  projectName: z.string(),
  // Repos the sprint touches, set during `sprint plan`. Required (defaults
  // to `[]` on a fresh draft sprint, populated post-plan).
  affectedRepositories: z.array(z.string()),
  // `Map<AbsolutePath, IsoTimestamp>` — serialised as a plain object map.
  setupRanAt: z.record(z.string(), z.string()),
  tickets: z.array(ticketJsonSchema),
});

export type SprintJson = z.infer<typeof sprintJsonSchema>;

// Sentinel slug consumed only as the slug-arg of `Sprint.create`. The factory
// uses `slug` only to derive an id — we always pass `id` explicitly so this
// value never appears in the result. Documented here so the `parse(...)`
// pattern can't be confused with a runtime input.
const SYNTHETIC_SLUG_R = Slug.parse('rehydrate');
if (!SYNTHETIC_SLUG_R.ok) throw SYNTHETIC_SLUG_R.error;
const SYNTHETIC_SLUG = SYNTHETIC_SLUG_R.value;

/**
 * Convert parsed JSON to a {@link Sprint} aggregate.
 *
 * Performance: VOs come from a JSON file already validated by Zod, so we
 * use the `trustString` escape hatch on the brand types. The aggregate is
 * reconstituted by walking the lifecycle forward (`addTicket` → `activate`
 * → `close`) starting from a fresh draft — this keeps the entity factory
 * the single source of truth for invariants and avoids a parallel
 * "rehydrate" code path on the entity itself.
 */
export function toSprint(parsed: SprintJson): Result<Sprint, StorageError> {
  const tickets: Ticket[] = [];
  for (const t of parsed.tickets) {
    const r = toTicket(t);
    if (!r.ok) return Result.error(r.error);
    tickets.push(r.value);
  }

  const setupRanAt = new Map<AbsolutePath, IsoTimestamp>();
  for (const [k, v] of Object.entries(parsed.setupRanAt)) {
    setupRanAt.set(AbsolutePath.trustString(k), IsoTimestamp.trustString(v));
  }

  const created = Sprint.create({
    id: SprintId.trustString(parsed.id),
    name: parsed.name,
    slug: SYNTHETIC_SLUG, // unused because we always pass `id`
    now: IsoTimestamp.trustString(parsed.createdAt),
    projectName: ProjectName.trustString(parsed.projectName),
    affectedRepositories: parsed.affectedRepositories.map((p) => AbsolutePath.trustString(p)),
  });
  if (!created.ok) {
    return Result.error(
      new StorageError({
        subCode: 'schema-mismatch',
        message: `sprint '${parsed.id}' failed entity validation: ${created.error.message}`,
        cause: created.error,
      })
    );
  }

  let s = created.value;
  // Tickets while still `draft` (the only phase that admits ticket adds).
  for (const ticket of tickets) {
    const r = s.addTicket(ticket);
    if (r.ok) s = r.value;
  }

  // Lifecycle: draft → active → closed.
  if (parsed.status === 'active' || parsed.status === 'closed') {
    const at = parsed.activatedAt ?? parsed.createdAt;
    const r = s.activate(IsoTimestamp.trustString(at));
    if (r.ok) s = r.value;
  }
  if (parsed.status === 'closed') {
    const at = parsed.closedAt ?? parsed.activatedAt ?? parsed.createdAt;
    const r = s.close(IsoTimestamp.trustString(at));
    if (r.ok) s = r.value;
  }

  // Apply setup stamps after lifecycle so a closed sprint still preserves
  // any persisted entries (defensive — closed sprints normally have empty
  // setupRanAt because `close()` clears them).
  for (const [path, at] of setupRanAt) {
    s = s.recordSetupRun(path, at);
  }

  if (parsed.branch !== null) {
    // setBranch is blocked once the sprint is `closed`. We honour that
    // contract — a closed sprint with a persisted branch is documenting
    // historical state and we don't override it via the public API. If the
    // entity ever needs to retain it, that's an entity-level change, not a
    // schema concern.
    const r = s.setBranch(parsed.branch);
    if (r.ok) s = r.value;
  }
  if (parsed.pullRequestUrl !== null) {
    const r = s.recordPullRequestUrl(parsed.pullRequestUrl);
    if (r.ok) s = r.value;
    // If a persisted URL fails the entity's invariant we silently drop it —
    // the rest of the sprint is still recoverable, and surfacing a fatal
    // error here would block reading the aggregate.
  }
  return Result.ok(s);
}

/** Reverse direction — Sprint entity → JSON-shaped object. */
export function fromSprint(sprint: Sprint): SprintJson {
  const setupRanAt: Record<string, string> = {};
  for (const [k, v] of sprint.setupRanAt) {
    setupRanAt[k] = v;
  }
  return {
    id: sprint.id,
    name: sprint.name,
    status: sprint.status,
    createdAt: sprint.createdAt,
    activatedAt: sprint.activatedAt,
    closedAt: sprint.closedAt,
    branch: sprint.branch,
    pullRequestUrl: sprint.pullRequestUrl,
    projectName: sprint.projectName,
    affectedRepositories: [...sprint.affectedRepositories],
    setupRanAt,
    tickets: sprint.tickets.map(fromTicket),
  };
}

function fromTicket(ticket: Ticket): TicketJson {
  return {
    id: ticket.id,
    title: ticket.title,
    ...(ticket.description !== undefined ? { description: ticket.description } : {}),
    ...(ticket.link !== undefined ? { link: ticket.link } : {}),
    requirementStatus: ticket.requirementStatus,
    ...(ticket.requirements !== undefined ? { requirements: ticket.requirements } : {}),
  };
}

function toTicket(parsed: TicketJson): Result<Ticket, StorageError> {
  const created = Ticket.create({
    id: TicketId.trustString(parsed.id),
    title: parsed.title,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.link !== undefined ? { link: parsed.link } : {}),
  });
  if (!created.ok) {
    return Result.error(
      new StorageError({
        subCode: 'schema-mismatch',
        message: `ticket '${parsed.id}' failed entity validation: ${created.error.message}`,
        cause: created.error,
      })
    );
  }
  let t = created.value;

  if (parsed.requirementStatus === 'approved') {
    const r = t.approveRequirements(parsed.requirements ?? '');
    if (r.ok) t = r.value;
  }
  return Result.ok(t);
}
