/**
 * Snapshot the on-disk shape of a sprint directory. Returns a structured view useful for both
 * pointed assertions (`snap.json('sprint.json').tickets[0].title`) and full diffs against a
 * golden tree (`expect(snap.tree).toEqual([...])`).
 *
 * Why: every regression we keep getting after the audit refactor is shaped like "the disk
 * layout drifted but nothing fails until a user opens the app and the file isn't where the
 * code expects it." Mock-repo tests cannot catch that class — only real-disk snapshots can.
 *
 * What it captures:
 *  - `tree`: every file path under the dir, relative + sorted. Catches "expected file missing"
 *    and "unexpected stray file appeared" in one diff.
 *  - `files`: raw content for known text files (json, md, txt, log, ndjson). Binaries are
 *    listed in `tree` but content is not loaded.
 *  - `json(path)`: typed convenience for `.json` files, throws on parse failure (regression
 *    surface: a schema migration left an invalid file behind).
 */

import { promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface SprintDirSnapshot {
  /** Sorted list of files (POSIX-style relative paths) under the snapshot root. */
  readonly tree: readonly string[];
  /** Raw text contents keyed by POSIX-style relative path. Only text-like files are loaded. */
  readonly files: Readonly<Record<string, string>>;
  /** Parse a `.json` file and return it typed. Throws if missing or unparsable. */
  readonly json: <T = unknown>(relPath: string) => T;
  /** Path back to the snapshot root (absolute). */
  readonly root: string;
}

/** Extensions whose content is loaded into `files`. Anything else is tracked in `tree` only. */
const TEXT_EXTENSIONS = new Set(['json', 'md', 'txt', 'log', 'ndjson', 'sh', 'yml', 'yaml', 'tsx', 'ts']);

/**
 * Walk a directory and return a structured snapshot. Missing root throws — the caller almost
 * always means "the directory should exist by now" and the surrounding test wants the failure
 * to be loud.
 */
export const readSprintDir = async (root: string): Promise<SprintDirSnapshot> => {
  const stat = await fs.stat(root).catch(() => null);
  if (stat === null || !stat.isDirectory()) {
    throw new Error(`readSprintDir: not a directory: ${root}`);
  }

  const tree: string[] = [];
  const files: Record<string, string> = {};
  await walk(root, root, tree, files);
  tree.sort();

  return {
    tree,
    files,
    root,
    json: <T = unknown>(relPath: string): T => {
      const content = files[relPath];
      if (content === undefined) {
        throw new Error(
          `readSprintDir: file not found in snapshot: ${relPath}\nTree:\n${tree.map((p) => `  - ${p}`).join('\n')}`
        );
      }
      try {
        return JSON.parse(content) as T;
      } catch (cause) {
        throw new Error(
          `readSprintDir: ${relPath} is not valid JSON: ${(cause as Error).message}\n--- content ---\n${content}\n---`,
          { cause }
        );
      }
    },
  };
};

const walk = async (root: string, current: string, tree: string[], files: Record<string, string>): Promise<void> => {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, tree, files);
      continue;
    }
    if (!entry.isFile()) continue; // skip symlinks / sockets / devices — wouldn't be ours
    const rel = relative(root, full).split(sep).join('/');
    tree.push(rel);
    const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (TEXT_EXTENSIONS.has(ext)) {
      files[rel] = await fs.readFile(full, 'utf8');
    }
  }
};
