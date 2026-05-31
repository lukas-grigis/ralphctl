import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ProbeError } from '@src/domain/value/error/probe-error.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { CodexArtifacts } from '@src/integration/ai/readiness/codex/artifacts.ts';
import { probeFile, probeNamedDirCollection } from '@src/integration/ai/readiness/_engine/probe-fs.ts';
import { absentState, presentState, type ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
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
