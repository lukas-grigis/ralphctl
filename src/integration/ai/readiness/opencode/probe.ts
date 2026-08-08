import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ProbeError } from '@src/domain/value/error/probe-error.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { OpencodeArtifacts } from '@src/integration/ai/readiness/opencode/artifacts.ts';
import { probeFile, probeNamedDirCollection } from '@src/integration/ai/readiness/_engine/probe-fs.ts';
import { absentState, presentState, type ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import { hasAnyOpencodeArtifact } from '@src/integration/ai/readiness/_engine/predicates.ts';
import type { ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';

/**
 * Filesystem probe for OpenCode artifacts. Looks under `repository.path` for:
 *   - `AGENTS.md` (project context memory, shared cross-tool convention)
 *   - `.opencode/skills/<name>/SKILL.md` (named project skills)
 *
 * Returns `present` iff at least one artifact was discovered. Read errors are surfaced as
 * {@link ProbeError}; absent paths are normal.
 */
export const opencodeProbe: ReadinessProbe<OpencodeArtifacts> = {
  tool: 'opencode',
  async evaluate(repository: Repository, now: IsoTimestamp): Promise<Result<ReadinessState, ProbeError>> {
    const root = repository.path;

    const agentsMd = await probeFile(join(root, 'AGENTS.md'));
    if (!agentsMd.ok) return Result.error(agentsMd.error);

    const skills = await probeNamedDirCollection(join(root, '.opencode/skills'), 'SKILL.md');
    if (!skills.ok) return Result.error(skills.error);

    const artifacts: OpencodeArtifacts = {
      tool: 'opencode',
      ...(agentsMd.value !== undefined ? { agentsMd: agentsMd.value } : {}),
      skills: skills.value,
    };
    return Result.ok(hasAnyOpencodeArtifact(artifacts) ? presentState(now, artifacts) : absentState(now));
  },
};
