import { Result } from '@src/domain/result.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ProbeError } from '@src/domain/value/error/probe-error.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { CodexArtifacts } from '@src/integration/ai/readiness/codex/artifacts.ts';
import { type ReadinessState, unknownState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';

/**
 * Codex probe — placeholder. Codex's on-disk readiness signature is not yet finalized; the
 * probe reports `unknown` until we know what to look for. Adding fields to
 * `CodexArtifacts` and a real filesystem walk here is the migration path.
 */
export const codexProbe: ReadinessProbe<CodexArtifacts> = {
  tool: 'codex',
  evaluate(repository: Repository, now: IsoTimestamp): Promise<Result<ReadinessState, ProbeError>> {
    void repository;
    void now;
    return Promise.resolve(Result.ok(unknownState));
  },
};
