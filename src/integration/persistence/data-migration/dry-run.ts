import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { isUuidv7 } from '@src/domain/value/uuid7.ts';
import { Slug } from '@src/domain/value/slug.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { isNodeErrnoCode, listDir, pathExists, pathIsDirectory } from '@src/integration/io/fs.ts';
import { buildSluggedName, NAME_SEPARATOR, parseIdFromName } from '@src/integration/persistence/storage.ts';
import { DATA_VERSION_FILENAME } from '@src/integration/persistence/data-migration/version-marker.ts';
import type {
  DryRunReport,
  MemoryMergePlan,
  MigrationEntryKind,
  MigrationProblem,
  RenamePlan,
  SkippedEntry,
} from '@src/integration/persistence/data-migration/types.ts';

const PROJECTS_DIR = 'projects';
const SPRINTS_DIR = 'sprints';
const MEMORY_DIR = 'memory';
const SPRINT_JSON = 'sprint.json';
const REASON_ALREADY_MIGRATED = 'already migrated (slugged name)';
const REASON_MALFORMED_NAME = 'malformed name — not a uuidv7 id';
const REASON_STAT_FAILED = 'could not stat the entry or its target — left in place';
const REASON_ORPHAN_MEMORY = 'orphan memory dir — no owning project; left in place (reclaim via housekeeping)';
const REASON_SYMLINK_LOOP = 'symlink loop — not a real entry; left in place';

/**
 * Mutable accumulators for a single dry-run pass. Returned (frozen) as a {@link DryRunReport}.
 */
interface Accumulator {
  readonly planned: RenamePlan[];
  readonly merges: MemoryMergePlan[];
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
 *  - SKIPPED — already-migrated (`<id>--<slug>` form), the version marker, an unrelated file, a
 *    symlink loop, or an orphan memory dir whose project no longer exists.
 *  - PROBLEM — a collision (target exists and differs), a malformed / non-uuid name, a missing /
 *    unreadable slug, or an unwritable backup target.
 *
 * Touches NOTHING — callers (tests) assert the tree is byte-identical after a dry-run.
 */
export const dryRun = async (dataRoot: AbsolutePath): Promise<DryRunReport> => {
  const acc: Accumulator = { planned: [], merges: [], skipped: [], problems: [] };

  // A single shared problem if the backup target is unwritable — the whole migration would fail at
  // apply time, so flag it once up front rather than per-entry.
  await checkBackupTargetWritable(dataRoot, acc);

  await scanFileFamily(dataRoot, PROJECTS_DIR, 'project', readProjectSlug, acc);
  await scanDirFamily(dataRoot, SPRINTS_DIR, 'sprint', (entryDir) => readSprintSlug(entryDir), acc);
  // Memory has its OWN scan: a legacy bare `<id>/` whose slugged sibling already exists is a MERGE
  // (append-only ledgers union cleanly), never the blocking collision a project/sprint both-dirs is.
  await scanMemoryFamily(dataRoot, acc);

  return { planned: acc.planned, merges: acc.merges, skipped: acc.skipped, problems: acc.problems };
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
    const present = await pathExists(join(parent, name));
    if (!present.ok) {
      recordStatFault(acc, name, present.error);
      continue;
    }
    const base = name.slice(0, -'.json'.length);
    if (base.includes(NAME_SEPARATOR)) {
      acc.skipped.push({ name, reason: REASON_ALREADY_MIGRATED });
      continue;
    }
    if (!isUuidv7(base)) {
      acc.problems.push({ name, reason: REASON_MALFORMED_NAME });
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
    const isDir = await pathIsDirectory(full);
    if (!isDir.ok) {
      recordStatFault(acc, name, isDir.error);
      continue;
    }
    if (!isDir.value) {
      acc.skipped.push({ name, reason: 'not a directory' });
      continue;
    }
    if (name.includes(NAME_SEPARATOR)) {
      acc.skipped.push({ name, reason: REASON_ALREADY_MIGRATED });
      continue;
    }
    if (!isUuidv7(name)) {
      acc.problems.push({ name, reason: REASON_MALFORMED_NAME });
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
 * Scan the `memory/` family. Like {@link scanDirFamily} for the simple bare-`<id>` → `<id>--<slug>`
 * rename, EXCEPT the both-dirs case: when a legacy bare `<projectId>/` dir's slugged target ALREADY
 * exists, this is a MERGE (record a {@link MemoryMergePlan}), not a blocking collision. Learnings
 * ledgers are append-only and de-dup by record `id`, so the two dirs union cleanly — and treating it
 * as a problem would permanently `dry-run-block` the gate for any user who ever had a split dir.
 */
const scanMemoryFamily = async (dataRoot: AbsolutePath, acc: Accumulator): Promise<void> => {
  const parent = join(String(dataRoot), MEMORY_DIR);
  const entries = await listDir(parent);
  if (!entries.ok) return;
  for (const name of entries.value) {
    await classifyMemoryEntry(dataRoot, parent, name, acc);
  }
};

/**
 * Classify ONE `memory/` entry: skip non-dirs / already-migrated / the marker, flag malformed or
 * slug-less dirs, and for a legacy bare `<id>/` either record a MERGE (slugged sibling already
 * present) or a plain rename. Split out of {@link scanMemoryFamily} to keep each function's branching
 * shallow.
 */
const classifyMemoryEntry = async (
  dataRoot: AbsolutePath,
  parent: string,
  name: string,
  acc: Accumulator
): Promise<void> => {
  if (name === DATA_VERSION_FILENAME) return void acc.skipped.push({ name, reason: 'version marker' });
  const full = join(parent, name);
  const isDir = await pathIsDirectory(full);
  if (!isDir.ok) return recordStatFault(acc, name, isDir.error);
  if (!isDir.value) return void acc.skipped.push({ name, reason: 'not a directory' });
  if (name.includes(NAME_SEPARATOR)) {
    return void acc.skipped.push({ name, reason: REASON_ALREADY_MIGRATED });
  }
  if (!isUuidv7(name)) return void acc.problems.push({ name, reason: REASON_MALFORMED_NAME });

  const owner = await readProjectSlugForId(dataRoot, name);
  if (owner.kind === 'no-project') return void acc.skipped.push({ name, reason: REASON_ORPHAN_MEMORY });
  if (owner.kind === 'unreadable') return void acc.problems.push({ name, reason: 'missing or unreadable slug' });
  const { slug } = owner;

  const toName = buildSluggedName(name, slug);
  const toFull = join(parent, toName);
  const sluggedPresent = await pathExists(toFull);
  if (!sluggedPresent.ok) return void acc.problems.push({ name, reason: REASON_STAT_FAILED });
  if (sluggedPresent.value) {
    // Both dirs present → MERGE the legacy ledger into the slugged one (apply unions + dedups by id).
    const legacy = AbsolutePath.parse(full);
    const slugged = AbsolutePath.parse(toFull);
    if (!legacy.ok || !slugged.ok) {
      return void acc.problems.push({ name, reason: 'could not build absolute paths for the memory merge' });
    }
    return void acc.merges.push({ projectId: name, legacyDir: legacy.value, sluggedDir: slugged.value });
  }
  await planRename(parent, name, toName, name, slug, 'memory', acc);
};

/**
 * Classify an entry whose own stat failed. A symlink loop resolves to nothing, so there is no data to
 * migrate or lose — skip it rather than block the whole gate; any other fault stays a problem.
 */
const recordStatFault = (acc: Accumulator, name: string, error: StorageError): void => {
  if (isNodeErrnoCode(error.cause, 'ELOOP')) acc.skipped.push({ name, reason: REASON_SYMLINK_LOOP });
  else acc.problems.push({ name, reason: REASON_STAT_FAILED });
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
  const taken = await pathExists(toFull);
  if (!taken.ok) {
    acc.problems.push({ name: fromName, reason: REASON_STAT_FAILED });
    return;
  }
  if (taken.value) {
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

/** Read the top-level `slug` from a project `.json` file; `undefined` when missing/invalid. */
const readProjectSlug = async (filePath: string): Promise<string | undefined> => readSlugField(filePath);

/** Read the top-level `slug` from a sprint dir's `sprint.json`; `undefined` when missing/invalid. */
const readSprintSlug = async (sprintDir: string): Promise<string | undefined> =>
  readSlugField(join(sprintDir, SPRINT_JSON));

type OwningProjectSlug =
  { readonly kind: 'slug'; readonly slug: string } | { readonly kind: 'no-project' } | { readonly kind: 'unreadable' };

/**
 * Resolve the OWNING PROJECT's slug for a memory directory named `<projectId>`. The slug is NOT in
 * the memory dir — it lives in `projects/<projectId>--<slug>.json` (or the legacy bare
 * `<projectId>.json`). `no-project` when no project file carries that id (an orphan left by a
 * removal without the memory cascade); `unreadable` when the projects dir or the file's slug can't be read.
 */
const readProjectSlugForId = async (dataRoot: AbsolutePath, projectId: string): Promise<OwningProjectSlug> => {
  const projects = join(String(dataRoot), PROJECTS_DIR);
  const entries = await listDir(projects);
  if (!entries.ok) return { kind: 'unreadable' };
  const match = entries.value.find((n) => n.endsWith('.json') && parseIdFromName(n) === projectId);
  if (match === undefined) return { kind: 'no-project' };
  const slug = await readSlugField(join(projects, match));
  return slug === undefined ? { kind: 'unreadable' } : { kind: 'slug', slug };
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
