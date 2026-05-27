import { promises as fs, type Stats } from 'node:fs';
import { basename, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';
import { ProbeError } from '@src/domain/value/error/probe-error.ts';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';
import type { ArtifactRef, NamedArtifactRef } from '@src/integration/ai/readiness/_engine/artifact-ref.ts';

/**
 * Stat a single file and report a typed {@link ArtifactRef} if and only if it exists as a
 * regular file. Missing paths resolve to `undefined` (a normal absence); permission / I/O
 * failures surface as {@link ProbeError}. Shared across per-tool readiness probes so they all
 * classify FS errors identically.
 */
export const probeFile = async (path: string): Promise<Result<ArtifactRef | undefined, ProbeError>> => {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) return Result.ok(undefined);
    return Result.ok({ path: path as AbsolutePath });
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) return Result.ok(undefined);
    if (isNodeErrnoCode(cause, 'EACCES')) {
      return Result.error(
        new ProbeError({ subCode: 'fs-permission', message: `permission denied reading ${path}`, path, cause })
      );
    }
    return Result.error(new ProbeError({ subCode: 'fs-read', message: `failed to stat ${path}`, path, cause }));
  }
};

/**
 * Walk `<dir>/<name>/<childMarker>` collections (e.g. `.claude/skills/<name>/SKILL.md`). Each
 * immediate sub-directory of `dir` that contains the `childMarker` file becomes a
 * {@link NamedArtifactRef} whose `name` is the slugified directory name. Sub-directories
 * without the marker, or with names that don't slugify, are silently skipped.
 */
export const probeNamedDirCollection = async (
  dir: string,
  childMarker: string
): Promise<Result<NamedArtifactRef[], ProbeError>> => {
  const entries = await listDir(dir);
  if (!entries.ok) return Result.error(entries.error);
  const refs: NamedArtifactRef[] = [];
  for (const entry of entries.value) {
    const childDir = join(dir, entry);
    const stat = await statSafely(childDir);
    if (!stat.ok) return Result.error(stat.error);
    if (stat.value === undefined || !stat.value.isDirectory()) continue;
    const markerPath = join(childDir, childMarker);
    const markerStat = await statSafely(markerPath);
    if (!markerStat.ok) return Result.error(markerStat.error);
    if (markerStat.value === undefined || !markerStat.value.isFile()) continue;
    const slug = Slug.parse(toKebabCase(basename(entry)));
    if (!slug.ok) continue;
    refs.push({ name: slug.value, path: markerPath as AbsolutePath });
  }
  return Result.ok(refs);
};

/**
 * Walk a flat `<dir>/<name>.md` collection (e.g. `.claude/commands/<name>.md`). Each `.md`
 * file becomes a {@link NamedArtifactRef} keyed on the slugified base name. Non-`.md` entries
 * and names that don't slugify are silently skipped.
 */
export const probeNamedFileCollection = async (dir: string): Promise<Result<NamedArtifactRef[], ProbeError>> => {
  const entries = await listDir(dir);
  if (!entries.ok) return Result.error(entries.error);
  const refs: NamedArtifactRef[] = [];
  for (const entry of entries.value) {
    if (!entry.endsWith('.md')) continue;
    const full = join(dir, entry);
    const stat = await statSafely(full);
    if (!stat.ok) return Result.error(stat.error);
    if (stat.value === undefined || !stat.value.isFile()) continue;
    const baseName = entry.slice(0, -'.md'.length);
    const slug = Slug.parse(toKebabCase(baseName));
    if (!slug.ok) continue;
    refs.push({ name: slug.value, path: full as AbsolutePath });
  }
  return Result.ok(refs);
};

/**
 * List a directory's immediate entries. Missing or non-directory paths resolve to an empty
 * list (normal absence); permission / I/O failures surface as {@link ProbeError}.
 */
export const listDir = async (dir: string): Promise<Result<string[], ProbeError>> => {
  try {
    return Result.ok(await fs.readdir(dir));
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) return Result.ok([]);
    if (isNodeErrnoCode(cause, 'EACCES')) {
      return Result.error(
        new ProbeError({ subCode: 'fs-permission', message: `permission denied listing ${dir}`, path: dir, cause })
      );
    }
    return Result.error(new ProbeError({ subCode: 'fs-read', message: `failed to read ${dir}`, path: dir, cause }));
  }
};

/**
 * Stat a path without throwing on `ENOENT` — the missing case resolves to `undefined` so
 * callers can branch on existence without try/catch noise. Permission / I/O failures still
 * surface as {@link ProbeError}.
 *
 * @public
 */
export const statSafely = async (path: string): Promise<Result<Stats | undefined, ProbeError>> => {
  try {
    return Result.ok(await fs.stat(path));
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) return Result.ok(undefined);
    if (isNodeErrnoCode(cause, 'EACCES')) {
      return Result.error(
        new ProbeError({ subCode: 'fs-permission', message: `permission denied stat ${path}`, path, cause })
      );
    }
    return Result.error(new ProbeError({ subCode: 'fs-read', message: `failed to stat ${path}`, path, cause }));
  }
};

/**
 * Read a UTF-8 text file. Missing files resolve to `undefined` (a normal absence); permission
 * / I/O failures surface as {@link ProbeError}. Used by probes that need to spelunk the
 * contents of a config file (e.g. extracting hook commands from `settings.json`).
 */
export const readFileSafely = async (path: AbsolutePath): Promise<Result<string | undefined, ProbeError>> => {
  try {
    return Result.ok(await fs.readFile(path, 'utf8'));
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) return Result.ok(undefined);
    if (isNodeErrnoCode(cause, 'EACCES')) {
      return Result.error(
        new ProbeError({ subCode: 'fs-permission', message: `permission denied reading ${path}`, path, cause })
      );
    }
    return Result.error(new ProbeError({ subCode: 'fs-read', message: `failed to read ${path}`, path, cause }));
  }
};
