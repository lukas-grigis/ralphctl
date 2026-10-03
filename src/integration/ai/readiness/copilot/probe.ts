import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ProbeError } from '@src/domain/value/error/probe-error.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { CopilotArtifacts } from '@src/integration/ai/readiness/copilot/artifacts.ts';
import { probeFile } from '@src/integration/ai/readiness/_engine/probe-fs.ts';
import { absentState, presentState, type ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';

/**
 * Filesystem probe for GitHub Copilot artifacts. v1 only checks the canonical instructions
 * file at `.github/copilot-instructions.md`.
 */
export const copilotProbe: ReadinessProbe<CopilotArtifacts> = {
  tool: 'copilot',
  async evaluate(repository: Repository, now: IsoTimestamp): Promise<Result<ReadinessState, ProbeError>> {
    const ref = await probeFile(join(repository.path, '.github/copilot-instructions.md'));
    if (!ref.ok) return Result.error(ref.error);
    return Result.ok(
      ref.value === undefined
        ? absentState(now)
        : presentState(now, { tool: 'copilot', copilotInstructions: ref.value })
    );
  },
};
