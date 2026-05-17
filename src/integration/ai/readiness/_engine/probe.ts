import type { Result } from '@src/domain/result.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { ToolArtifacts } from '@src/integration/ai/readiness/_engine/tool-artifacts.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { ProbeError } from '@src/domain/value/error/probe-error.ts';

/**
 * Pure interface for an readiness probe. The integration layer implements one per
 * {@link AssistantTool}; the domain only describes the shape.
 *
 * `T extends ToolArtifacts` lets each implementation narrow its return type to its tool's
 * artifact shape. The probe itself is responsible for filesystem I/O — domain code never
 * imports it directly; business code does.
 *
 * Returning `Result.ok(absent)` is normal — that's "I checked and found nothing". `ProbeError`
 * is reserved for situations where the probe could not finish its work (read error,
 * permission denied, malformed config).
 */
export interface ReadinessProbe<T extends ToolArtifacts> {
  readonly tool: T['tool'];
  evaluate(repository: Repository, now: IsoTimestamp): Promise<Result<ReadinessState, ProbeError>>;
}

/** Map of probes keyed by tool. The business orchestrator picks the matching probe for a query. */
export type ReadinessProbeRegistry = Readonly<Partial<Record<AssistantTool, ReadinessProbe<ToolArtifacts>>>>;
