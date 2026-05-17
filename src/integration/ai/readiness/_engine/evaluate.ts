import { Result } from '@src/domain/result.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import { unknownState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { ReadinessProbeRegistry } from '@src/integration/ai/readiness/_engine/probe.ts';
import type { ProbeError } from '@src/domain/value/error/probe-error.ts';

export interface EvaluateReadinessDeps {
  readonly probes: ReadinessProbeRegistry;
}

/**
 * Run a single (Repository, Tool) probe. If no probe is registered for the tool, returns
 * `unknown` — the harness can decide whether that's acceptable or surface a configuration
 * error to the user.
 */
export const evaluateReadiness = async (
  deps: EvaluateReadinessDeps,
  repository: Repository,
  tool: AssistantTool,
  now: IsoTimestamp
): Promise<Result<ReadinessState, ProbeError>> => {
  const probe = deps.probes[tool];
  if (probe === undefined) return Result.ok(unknownState);
  return probe.evaluate(repository, now);
};
