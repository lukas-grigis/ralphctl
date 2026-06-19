import { promises as fs, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from '@src/domain/value/uuid7.ts';

/**
 * Seed helpers for the data-migration engine tests. Build a fake `data/` tree on disk with a mix of
 * legacy bare-`<id>` and new `<id>--<slug>` entries across the three families, so the dry-run / apply
 * tests exercise the real filesystem (this is the safety surface — no mocked fs).
 */

export const SLUG_A = 'alpha-project';
export const SLUG_B = 'beta-sprint';

/** A fresh real uuidv7 — used so the dry-run's `isUuidv7` gate passes for legitimate entries. */
export const freshId = (): string => uuidv7();

/** Write a legacy bare-`<id>.json` project file carrying a top-level `slug`. */
export const seedLegacyProject = async (dataRoot: string, id: string, slug: string): Promise<void> => {
  const dir = join(dataRoot, 'projects');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `${id}.json`), JSON.stringify({ id, slug, name: 'X' }), 'utf8');
};

/** Write an already-migrated `<id>--<slug>.json` project file. */
export const seedNewProject = async (dataRoot: string, id: string, slug: string): Promise<void> => {
  const dir = join(dataRoot, 'projects');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `${id}--${slug}.json`), JSON.stringify({ id, slug, name: 'X' }), 'utf8');
};

/** Write a legacy bare-`<id>/` sprint directory with a `sprint.json` carrying a `slug`. */
export const seedLegacySprint = async (dataRoot: string, id: string, slug: string): Promise<void> => {
  const dir = join(dataRoot, 'sprints', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'sprint.json'), JSON.stringify({ id, slug }), 'utf8');
  await fs.writeFile(join(dir, 'tasks.json'), JSON.stringify({ tasks: [] }), 'utf8');
};

/** Write an already-migrated `<id>--<slug>/` sprint directory. */
export const seedNewSprint = async (dataRoot: string, id: string, slug: string): Promise<void> => {
  const dir = join(dataRoot, 'sprints', `${id}--${slug}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'sprint.json'), JSON.stringify({ id, slug }), 'utf8');
};

/**
 * Write a legacy memory dir `<projectId>/` with a `learnings.ndjson`. The slug for a memory dir comes
 * from the OWNING project file, so callers must also seed a matching project (legacy or new).
 */
export const seedLegacyMemory = async (dataRoot: string, projectId: string, ndjson = ''): Promise<void> => {
  const dir = join(dataRoot, 'memory', projectId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'learnings.ndjson'), ndjson, 'utf8');
};

/**
 * Write a slugged memory dir `<projectId>--<projectSlug>/` with a `learnings.ndjson`. Used alongside
 * {@link seedLegacyMemory} to construct the both-dirs MERGE case the apply step must resolve.
 */
export const seedNewMemory = async (dataRoot: string, projectId: string, slug: string, ndjson = ''): Promise<void> => {
  const dir = join(dataRoot, 'memory', `${projectId}--${slug}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'learnings.ndjson'), ndjson, 'utf8');
};

/** Recursively list every file path under a directory, relative to it, sorted — for tree snapshots. */
export const snapshotTree = async (root: string): Promise<readonly string[]> => {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) await walk(join(dir, e.name), rel);
      else out.push(rel);
    }
  };
  await walk(root, '');
  return out.sort();
};

/** Snapshot of `<rel-path> → byte-content` for every file under a dir — for byte-identical asserts. */
export const snapshotContents = async (root: string): Promise<Record<string, string>> => {
  const files = await snapshotTree(root);
  const out: Record<string, string> = {};
  for (const f of files) out[f] = await fs.readFile(join(root, f), 'utf8');
  return out;
};
