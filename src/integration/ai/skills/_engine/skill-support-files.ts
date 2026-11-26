/**
 * Read and write the support files of a skill folder — everything under the allowlisted
 * {@link SKILL_SUPPORT_DIRS} (`references/`, `scripts/`, `assets/`) that travels with `SKILL.md`.
 *
 * Reading is shared by every on-disk source (bundled, operator, phase) and the phase catalog;
 * writing is shared by the provider install path and the catalog copy. Both sides apply the same
 * rules, so a folder installs exactly what was read:
 *  - only regular files under an allowlisted top-level dir; dotfiles and symlinks are skipped
 *    (a symlink could pull a file from outside the skill into a repo);
 *  - a UTF-8 file is carried as text, anything else (an image or font under `assets/`) as bytes, and
 *    an executable source file is written back executable so a bundled script stays runnable;
 *  - paths are forward-slash relative, sorted, and re-validated before a write so a hand-built
 *    {@link SkillFile} can't escape the destination folder;
 *  - a folder over {@link MAX_SUPPORT_FILES} files / {@link MAX_SUPPORT_BYTES} bytes is an error
 *    rather than a silent partial copy.
 */

import { type Dirent, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { isNodeErrnoCode, writeFileAtomic } from '@src/integration/io/fs.ts';
import { SKILL_SUPPORT_DIRS, type SkillFile } from '@src/integration/ai/skills/_engine/skill.ts';

// Fallback caps against a runaway folder (a vendored node_modules dropped into assets/), not a budget.
const MAX_SUPPORT_FILES = 256;
const MAX_SUPPORT_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 8;

const SUPPORT_DIR_SET: ReadonlySet<string> = new Set(SKILL_SUPPORT_DIRS);
const SAFE_SEGMENT = /^[^/\\\0]+$/u;

/** True when `path` is a forward-slash relative path inside an allowlisted support dir. */
export const isSafeSupportPath = (path: string): boolean => {
  const segments = path.split('/');
  if (segments.length < 2 || !SUPPORT_DIR_SET.has(segments[0] ?? '')) return false;
  return segments.every((s) => SAFE_SEGMENT.test(s) && s !== '.' && s !== '..');
};

interface WalkState {
  readonly files: SkillFile[];
  bytes: number;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

const decodeText = (bytes: Uint8Array): string | undefined => {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
};

const supportError = (message: string, path: string, cause?: unknown): StorageError =>
  new StorageError({ subCode: 'io', message, path, ...(cause !== undefined ? { cause } : {}) });

const readSupportFile = async (abs: string, rel: string, state: WalkState): Promise<StorageError | undefined> => {
  let bytes: Buffer;
  let executable: boolean;
  try {
    bytes = await fs.readFile(abs);
    executable = ((await fs.stat(abs)).mode & 0o111) !== 0;
  } catch (cause) {
    return supportError(`skill support file not readable: ${abs}`, abs, cause);
  }
  state.bytes += bytes.byteLength;
  if (state.files.length >= MAX_SUPPORT_FILES || state.bytes > MAX_SUPPORT_BYTES) {
    return supportError(
      `skill support files exceed ${String(MAX_SUPPORT_FILES)} files / ${String(MAX_SUPPORT_BYTES)} bytes at ${abs}`,
      abs
    );
  }
  state.files.push({
    path: rel,
    content: decodeText(bytes) ?? new Uint8Array(bytes),
    ...(executable ? { executable: true as const } : {}),
  });
  return undefined;
};

const walk = async (abs: string, rel: string, depth: number, state: WalkState): Promise<StorageError | undefined> => {
  if (depth > MAX_DEPTH)
    return supportError(`skill support folder nests deeper than ${String(MAX_DEPTH)}: ${abs}`, abs);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (cause) {
    return supportError(`skill support folder not readable: ${abs}`, abs, cause);
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childAbs = join(abs, entry.name);
    const childRel = `${rel}/${entry.name}`;
    // Dirent types come from lstat, so a symlink is neither a file nor a directory here.
    const err = entry.isDirectory()
      ? await walk(childAbs, childRel, depth + 1, state)
      : entry.isFile()
        ? await readSupportFile(childAbs, childRel, state)
        : undefined;
    if (err !== undefined) return err;
  }
  return undefined;
};

/** Read every allowlisted support file under `skillDir`, sorted by path. No support dirs → `[]`. */
export const readSkillSupportFiles = async (skillDir: string): Promise<Result<readonly SkillFile[], StorageError>> => {
  const state: WalkState = { files: [], bytes: 0 };
  for (const dir of SKILL_SUPPORT_DIRS) {
    const abs = join(skillDir, dir);
    let isDir: boolean;
    try {
      isDir = (await fs.lstat(abs)).isDirectory();
    } catch (cause) {
      if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) continue;
      return Result.error(supportError(`skill support folder not readable: ${abs}`, abs, cause));
    }
    if (!isDir) continue;
    const err = await walk(abs, dir, 1, state);
    if (err !== undefined) return Result.error(err);
  }
  return Result.ok([...state.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
};

/**
 * Write `files` under `skillDir`, refusing any path outside the allowlist. Text goes through the
 * injected atomic seam; bytes and executables need the byte- and mode-aware atomic writer.
 */
export const writeSkillSupportFiles = async (
  skillDir: string,
  files: readonly SkillFile[],
  writeFile: WriteFile
): Promise<Result<void, StorageError>> => {
  for (const file of files) {
    if (!isSafeSupportPath(file.path)) {
      return Result.error(
        new StorageError({
          subCode: 'schema-mismatch',
          message: `refusing skill support file ${JSON.stringify(file.path)} — it must sit under ${SKILL_SUPPORT_DIRS.join('/, ')}/`,
          path: skillDir,
        })
      );
    }
    const target = AbsolutePath.parse(join(skillDir, ...file.path.split('/')));
    if (!target.ok) return Result.error(supportError(`skill support path not absolute: ${skillDir}`, skillDir));
    const written =
      typeof file.content === 'string' && file.executable !== true
        ? await writeFile(target.value, file.content)
        : await writeFileAtomic(String(target.value), file.content, file.executable === true ? 0o755 : undefined);
    if (!written.ok) return written;
  }
  return Result.ok(undefined);
};
