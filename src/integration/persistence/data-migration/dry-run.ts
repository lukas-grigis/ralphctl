import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { isUuidv7 } from '@src/domain/value/uuid7.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { listDir } from '@src/integration/io/fs.ts';
import { buildSluggedName, NAME_SEPARATOR } from '@src/integration/persistence/storage.ts';
import { DATA_VERSION_FILENAME } from '@src/integration/persistence/data-migration/version-marker.ts';
import type {
  DryRunReport,
  MigrationEntryKind,
  MigrationProblem,
  RenamePlan,
  SkippedEntry,
} from '@src/integration/persistence/data-migration/types.ts';

const PROJECTS_DIR = 'projects';
const SPRINTS_DIR = 'sprints';
const MEMORY_DIR = 'memory';
const SPRINT_JSON = 'sprint.json';

/**
 * Mutable accumulators for a single dry-run pass. Returned (frozen) as a {@link DryRunReport}.
 */
interface Accumulator {
  readonly planned: RenamePlan[];
  readonly skipped: SkippedEntry[];
  readonly problems: MigrationProblem[];
}

/**
 * Scan the `data/` tree and compute the set of renames a migration WOULD perform, without touching
 * anything on disk. For every legacy bare-`<id>` entry under `projects/`, `sprints/`, and `memory/`
 * it computes the target `<id>--<slug>` name (slug read from the entry's JSON — `slug` in
 * `project.json` / `sprint.json`, and the OWNING PROJECT's slug for a memory dir).
 *
 * Classification:
 *  - PLANNED — a legacy bare-`<id>` entry with a readable slug and a free target name.
 *  - SKIPPED — already-migrated (`<id>--<slug>` form), the version marker, or an unrelated file.
 *  - PROBLEM — a collision (target exists and differs), a malformed / non-uuid name, a missing /
 *    unreadable slug, or an unwritable backup target.
 *
 * Touches NOTHING — callers (tests) assert the tree is byte-identical after a dry-run.
 *
 * @public
 */
export const dryRun = async (dataRoot: AbsolutePath): Promise<DryRunReport> => {
  const acc: Accumulator = { planned: [], skipped: [], problems: [] };

  // A single shared problem if the backup target is unwritable — the whole migration would fail at
  // apply time, so flag it once up front rather than per-entry.
  await checkBackupTargetWritable(dataRoot, acc);

  await scanFileFamily(dataRoot, PROJECTS_DIR, 'project', readProjectSlug, acc);
  await scanDirFamily(dataRoot, SPRINTS_DIR, 'sprint', (entryDir) => readSprintSlug(entryDir), acc);
  await scanDirFamily(dataRoot, MEMORY_DIR, 'memory', (_entryDir, id) => readProjectSlugForId(dataRoot, id), acc);

  return { planned: acc.planned, skipped: acc.skipped, problems: acc.problems };
};

/**
 * The parent of `data/` must be writable for `backupDataDir` to create the sibling backup dir. If it
 * is not, record ONE problem — the migration cannot proceed safely without a backup.
 */
const checkBackupTargetWritable = async (dataRoot: AbsolutePath, acc: Accumulator): Promise<void> => {
  const parent = join(String(dataRoot), '..');
  try {
    await fs.access(parent, fs.constants.W_OK);
  } catch {
    acc.problems.push({
      name: parent,
      reason: 'backup target (parent of data/) is not writable — a backup cannot be created',
    });
  }
};

/**
 * Scan a FILE family (`projects/` — flat `<id>--<slug>.json` files). Each `.json` entry whose name
 * is a legacy bare `<id>.json` is planned; an `<id>--<slug>.json` is skipped (already migrated).
 */
const scanFileFamily = async (
  dataRoot: AbsolutePath,
  dirName: string,
  kind: MigrationEntryKind,
  readSlug: (entryPath: string) => Promise<string | undefined>,
  acc: Accumulator
): Promise<void> => {
  const parent = join(String(dataRoot), dirName);
  const entries = await listDir(parent);
  if (!entries.ok) return;

  for (const name of entries.value) {
    if (!name.endsWith('.json')) {
      acc.skipped.push({ name, reason: 'not a project .json file' });
      continue;
    }
    const base = name.slice(0, -'.json'.length);
    if (base.includes(NAME_SEPARATOR)) {
      acc.skipped.push({ name, reason: 'already migrated (slugged name)' });
      continue;
    }
    if (!isUuidv7(base)) {
      acc.problems.push({ name, reason: 'malformed name — not a uuidv7 id' });
      continue;
    }
    const slug = await readSlug(join(parent, name));
    if (slug === undefined) {
      acc.problems.push({ name, reason: 'missing or unreadable slug in JSON' });
      continue;
    }
    await planRename(parent, name, `${buildSluggedName(base, slug)}.json`, base, slug, kind, acc);
  }
};

/**
 * Scan a DIRECTORY family (`sprints/`, `memory/` — per-id subdirectories). Each subdir whose name is
 * a legacy bare `<id>` is planned; an `<id>--<slug>` dir is skipped. The version marker file and any
 * existing `data.backup-*` siblings are never seen here (those live under `data/`, not the family
 * dir), but a stray FILE inside the family dir is skipped, not flagged.
 */
const scanDirFamily = async (
  dataRoot: AbsolutePath,
  dirName: string,
  kind: MigrationEntryKind,
  readSlug: (entryDir: string, id: string) => Promise<string | undefined>,
  acc: Accumulator
): Promise<void> => {
  const parent = join(String(dataRoot), dirName);
  const entries = await listDir(parent);
  if (!entries.ok) return;

  for (const name of entries.value) {
    if (name === DATA_VERSION_FILENAME) {
      acc.skipped.push({ name, reason: 'version marker' });
      continue;
    }
    const full = join(parent, name);
    const isDir = await isDirectory(full);
    if (!isDir) {
      acc.skipped.push({ name, reason: 'not a directory' });
      continue;
    }
    if (name.includes(NAME_SEPARATOR)) {
      acc.skipped.push({ name, reason: 'already migrated (slugged name)' });
      continue;
    }
    if (!isUuidv7(name)) {
      acc.problems.push({ name, reason: 'malformed name — not a uuidv7 id' });
      continue;
    }
    const slug = await readSlug(full, name);
    if (slug === undefined) {
      acc.problems.push({ name, reason: 'missing or unreadable slug' });
      continue;
    }
    await planRename(parent, name, buildSluggedName(name, slug), name, slug, kind, acc);
  }
};

/**
 * Build a {@link RenamePlan} for a legacy entry, OR record a collision problem when the target name
 * already exists and is NOT the same entry (a crash-left bare+slugged pair where the slugged form is
 * a different inode). When the target already exists, this is treated as a problem rather than a
 * silent overwrite — the apply step never clobbers an existing target.
 */
const planRename = async (
  parent: string,
  fromName: string,
  toName: string,
  id: string,
  slug: string,
  kind: MigrationEntryKind,
  acc: Accumulator
): Promise<void> => {
  if (fromName === toName) {
    acc.skipped.push({ name: fromName, reason: 'already at canonical name' });
    return;
  }
  const toFull = join(parent, toName);
  if (await pathPresent(toFull)) {
    acc.problems.push({
      name: fromName,
      reason: `collision — target ${toName} already exists; leaving legacy entry in place`,
    });
    return;
  }
  const from = AbsolutePath.parse(join(parent, fromName));
  const to = AbsolutePath.parse(toFull);
  if (!from.ok || !to.ok) {
    acc.problems.push({ name: fromName, reason: 'could not build an absolute path for the rename' });
    return;
  }
  acc.planned.push({ kind, id, slug, fromName, toName, from: from.value, to: to.value });
};

const pathPresent = async (path: string): Promise<boolean> => {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/** Read the top-level `slug` from a project `.json` file; `undefined` when missing/invalid. */
const readProjectSlug = async (filePath: string): Promise<string | undefined> => readSlugField(filePath);

/** Read the top-level `slug` from a sprint dir's `sprint.json`; `undefined` when missing/invalid. */
const readSprintSlug = async (sprintDir: string): Promise<string | undefined> =>
  readSlugField(join(sprintDir, SPRINT_JSON));

/**
 * Resolve the OWNING PROJECT's slug for a memory directory named `<projectId>`. The slug is NOT in
 * the memory dir — it lives in `projects/<projectId>--<slug>.json` (or the legacy bare
 * `<projectId>.json`). Scans the projects dir for the file whose leading id matches, then reads its
 * `slug`. `undefined` when no matching project file exists or its slug is unreadable.
 */
const readProjectSlugForId = async (dataRoot: AbsolutePath, projectId: string): Promise<string | undefined> => {
  const projects = join(String(dataRoot), PROJECTS_DIR);
  const entries = await listDir(projects);
  if (!entries.ok) return undefined;
  const match = entries.value.find((n) => {
    if (!n.endsWith('.json')) return false;
    const base = n.slice(0, -'.json'.length);
    const sep = base.indexOf(NAME_SEPARATOR);
    return (sep === -1 ? base : base.slice(0, sep)) === projectId;
  });
  if (match === undefined) return undefined;
  return readSlugField(join(projects, match));
};

/**
 * Read + validate the `slug` field of a JSON file. Returns the slug string only when the file
 * parses, has a top-level `slug`, and that slug passes the {@link Slug} smart constructor (so a
 * garbage slug never produces a malformed on-disk name). `undefined` otherwise.
 */
const readSlugField = async (filePath: string): Promise<string | undefined> => {
  let bytes: string;
  try {
    bytes = await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const slug = (raw as { slug?: unknown }).slug;
  const parsed = Slug.parse(slug);
  return parsed.ok ? String(parsed.value) : undefined;
};
