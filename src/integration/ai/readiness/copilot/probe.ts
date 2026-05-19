import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { ProbeError } from '@src/domain/value/error/probe-error.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';
import type { CopilotArtifacts } from '@src/integration/ai/readiness/copilot/artifacts.ts';
import { absentState, type ReadinessState, presentState } from '@src/integration/ai/readiness/_engine/state.ts';
import { hasAnyCopilotArtifact } from '@src/integration/ai/readiness/_engine/predicates.ts';
import type { ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';

/**
 * Filesystem probe for GitHub Copilot artifacts. v1 only checks the canonical instructions
 * file at `.github/copilot-instructions.md`.
 */
export const copilotProbe: ReadinessProbe<CopilotArtifacts> = {
  tool: 'copilot',
  async evaluate(repository: Repository, now: IsoTimestamp): Promise<Result<ReadinessState, ProbeError>> {
    const path = join(repository.path, '.github/copilot-instructions.md');
    try {
      const stat = await fs.stat(path);
      if (!stat.isFile()) return Result.ok(absentState(now));
      const artifacts: CopilotArtifacts = { tool: 'copilot', copilotInstructions: { path: path as AbsolutePath } };
      return Result.ok(hasAnyCopilotArtifact(artifacts) ? presentState(now, artifacts) : absentState(now));
    } catch (cause) {
      if (isNodeErrnoCode(cause, 'ENOENT')) return Result.ok(absentState(now));
      if (isNodeErrnoCode(cause, 'EACCES')) {
        return Result.error(
          new ProbeError({ subCode: 'fs-permission', message: `permission denied reading ${path}`, path, cause })
        );
      }
      return Result.error(new ProbeError({ subCode: 'fs-read', message: `failed to stat ${path}`, path, cause }));
    }
  },
};
