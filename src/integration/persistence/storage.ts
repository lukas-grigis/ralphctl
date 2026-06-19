import { join } from 'node:path';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { listDir } from '@src/integration/io/fs.ts';

/**
 * On-disk layout (rooted at `<root>`):
 *
 *   <root>/
 *     projects/
 *       <project-id>--<project-slug>.json
 *     sprints/
 *       <sprint-id>--<sprint-slug>/
 *         sprint.json
 *         execution.json
 *         tasks.json
 *
 * Projects are flat single-file JSON. Sprints get a per-sprint directory because a sprint
 * carries three sibling aggregates (the sprint itself, its execution, its task set) that the
 * domain treats as one unit of work — keeping them co-located makes "remove a sprint"
 * a single `rm -rf <sprint-dir>` regardless of which sub-files happened to exist.
 *
 * ## Human-readable names + tolerant readers
 *
 * Each entity's on-disk name is `<id>--<slug>` (the slug is a kebab handle and never contains
 * `--`, so the leading id is recoverable by splitting on the FIRST `--`). The slug makes the
 * `data/` tree browsable. Because a slug can be renamed — and because older installs used the
 * bare `<id>` name — EVERY reader must tolerate BOTH forms:
 *
 *  - direct-build helpers (`projectFile` / `sprintDir` / …) take the entity's slug and build the
 *    canonical `<id>--<slug>` path. Use these on the WRITE side (the entity is in hand).
 *  - the id-prefix resolver ({@link resolveEntityName} and its `resolveProjectPath` /
 *    `resolveSprintDir` / `resolveMemoryDir` wrappers) takes only an id and finds the matching
 *    entry whether it is the new `<id>--<slug>` form or the legacy bare `<id>` form (preferring
 *    the new form if both exist). Use these on the READ side when only the id is known.
 */

/** The id/slug separator. Kebab slugs never contain consecutive hyphens, so it is unambiguous. */
export const NAME_SEPARATOR = '--';

/**
 * Build the human-readable on-disk name for an entity: `<id>--<slug>`. Used by every WRITE-side
 * caller that already holds the entity (and therefore its slug). Pure — no I/O.
 *
 * @public
 */
export const buildSluggedName = (id: string, slug: string): string => `${id}${NAME_SEPARATOR}${slug}`;

/**
 * Recover the leading id from an on-disk entry name. Splits on the FIRST `--` (kebab slugs never
 * contain consecutive hyphens), so `<id>--<slug>` → `<id>` and a legacy bare `<id>` → `<id>`. A
 * trailing `.json` (project files) is stripped first so the same helper serves files and dirs.
 *
 * @public
 */
export const parseIdFromName = (entry: string): string => {
  const base = entry.endsWith('.json') ? entry.slice(0, -'.json'.length) : entry;
  const sep = base.indexOf(NAME_SEPARATOR);
  return sep === -1 ? base : base.slice(0, sep);
};

/**
 * Shared id-prefix resolver. Scans `parentDir` for the entry that belongs to `id` — either the
 * new `<id>--<anything>` form or the legacy bare `<id>` (or `<id>.json` when `suffix` is set).
 * Returns the matching ENTRY NAME (not a full path), or `undefined` when neither form exists.
 *
 * Preference order, when more than one entry matches (a crash between write + delete-old can
 * leave both): the new `<id>--<slug>` form wins over the bare `<id>` form, so callers converge on
 * the human-readable name. A non-matching / garbage entry (`.DS_Store`, an unrelated id, a
 * `not-a-uuid` directory) is simply ignored.
 *
 * This is the ONE place that does the tolerant scan; the per-entity wrappers below are thin.
 */
export const resolveEntityName = async (parentDir: string, id: string, suffix = ''): Promise<string | undefined> => {
  const entries = await listDir(parentDir);
  if (!entries.ok) return undefined; // unreadable parent → treat as "not found" (callers degrade)

  const bare = `${id}${suffix}`;
  const newPrefix = `${id}${NAME_SEPARATOR}`;
  let bareMatch: string | undefined;
  let newMatch: string | undefined;
  for (const entry of entries.value) {
    if (suffix.length > 0 && !entry.endsWith(suffix)) continue;
    if (entry === bare) {
      bareMatch = entry;
      continue;
    }
    if (entry.startsWith(newPrefix)) {
      // First new-form match wins; there should only ever be one per id by construction.
      newMatch ??= entry;
    }
  }
  return newMatch ?? bareMatch;
};

export const projectsDir = (root: AbsolutePath): string => join(String(root), 'projects');

/**
 * WRITE-side builder: the canonical `<id>--<slug>.json` project file path. Use on `save`, where
 * the {@link import('@src/domain/entity/project.ts').Project} (and thus its slug) is in hand.
 *
 * @public
 */
export const projectFile = (root: AbsolutePath, id: ProjectId, slug: Slug): string =>
  join(projectsDir(root), `${buildSluggedName(String(id), String(slug))}.json`);

/**
 * READ-side resolver: the project file for `id`, tolerant of both the new `<id>--<slug>.json`
 * name and the legacy bare `<id>.json`. `undefined` when neither exists.
 *
 * @public
 */
export const resolveProjectPath = async (root: AbsolutePath, id: ProjectId): Promise<string | undefined> => {
  const name = await resolveEntityName(projectsDir(root), String(id), '.json');
  return name === undefined ? undefined : join(projectsDir(root), name);
};

export const sprintsDir = (root: AbsolutePath): string => join(String(root), 'sprints');

/**
 * WRITE-side builder: the canonical `<id>--<slug>/` sprint directory path. Use on `save`.
 *
 * @public
 */
export const sprintDir = (root: AbsolutePath, id: SprintId, slug: Slug): string =>
  join(sprintsDir(root), buildSluggedName(String(id), String(slug)));

/**
 * READ-side resolver: the sprint directory for `id`, tolerant of both the new `<id>--<slug>/`
 * name and the legacy bare `<id>/`. `undefined` when neither exists.
 *
 * @public
 */
export const resolveSprintDir = async (root: AbsolutePath, id: SprintId): Promise<string | undefined> => {
  const name = await resolveEntityName(sprintsDir(root), String(id));
  return name === undefined ? undefined : join(sprintsDir(root), name);
};

export const sprintFile = (root: AbsolutePath, id: SprintId, slug: Slug): string =>
  join(sprintDir(root, id, slug), 'sprint.json');

/**
 * READ-side resolver for the per-project memory directory under `<dataRoot>/memory/`, tolerant of
 * both `<projectId>--<projectSlug>/` and the legacy bare `<projectId>/`. `undefined` when neither
 * exists. The slug-aware WRITE-side path is built directly by the memory ledger helpers.
 *
 * @public
 */
export const resolveMemoryDir = async (memoryRoot: AbsolutePath, projectId: string): Promise<string | undefined> => {
  const name = await resolveEntityName(String(memoryRoot), projectId);
  return name === undefined ? undefined : join(String(memoryRoot), name);
};
