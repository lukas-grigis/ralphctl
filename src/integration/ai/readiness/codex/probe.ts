import { promises as fs, type Stats } from 'node:fs';
import { basename, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { ProbeError } from '@src/domain/value/error/probe-error.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { CodexArtifacts } from '@src/integration/ai/readiness/codex/artifacts.ts';
import type { NamedArtifactRef } from '@src/integration/ai/readiness/_engine/artifact-ref.ts';
import { absentState, type ReadinessState, presentState } from '@src/integration/ai/readiness/_engine/state.ts';
import { hasAnyCodexArtifact } from '@src/integration/ai/readiness/_engine/predicates.ts';
import type { ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';

/**
 * Filesystem probe for Codex artifacts. Looks under `repository.path` for:
 *   - `AGENTS.md` (project context memory)
 *   - `.agents/skills/<name>/SKILL.md` (named project skills)
 *
 * Returns `present` iff at least one artifact was discovered. Read errors are surfaced as
 * {@link ProbeError}; absent paths are normal.
 */
export const codexProbe: ReadinessProbe<CodexArtifacts> = {
  tool: 'codex',
  async evaluate(repository: Repository, now: IsoTimestamp): Promise<Result<ReadinessState, ProbeError>> {
    const root = repository.path;

    const agentsMd = await probeFile(join(root, 'AGENTS.md'));
    if (!agentsMd.ok) return Result.error(agentsMd.error);

    const skills = await probeNamedDirCollection(join(root, '.agents/skills'), 'SKILL.md');
    if (!skills.ok) return Result.error(skills.error);

    const artifacts: CodexArtifacts = {
      tool: 'codex',
      ...(agentsMd.value !== undefined ? { agentsMd: agentsMd.value } : {}),
      skills: skills.value,
    };
    return Result.ok(hasAnyCodexArtifact(artifacts) ? presentState(now, artifacts) : absentState(now));
  },
};

const probeFile = async (path: string): Promise<Result<{ readonly path: AbsolutePath } | undefined, ProbeError>> => {
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

const probeNamedDirCollection = async (
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

const listDir = async (dir: string): Promise<Result<string[], ProbeError>> => {
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

const statSafely = async (path: string): Promise<Result<Stats | undefined, ProbeError>> => {
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

const isNodeErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code;
