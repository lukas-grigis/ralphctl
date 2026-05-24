import { Result } from '@src/domain/result.ts';
import type { ReadinessProbeRegistry } from '@src/integration/ai/readiness/_engine/probe.ts';
import type { ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { type IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { evaluateReadiness } from '@src/integration/ai/readiness/_engine/evaluate.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';

export interface ProbeReadinessLeafDeps {
  readonly probes: ReadinessProbeRegistry;
  readonly clock: () => IsoTimestamp;
}

interface ProbeReadinessInput {
  readonly repository: Repository;
}

/**
 * Adapter leaf around the existing {@link evaluateReadiness} use case. The factory closes over
 * the {@link AssistantTool} this instance probes for — the readiness flow constructs one
 * instance per unique tool referenced in settings.ai.
 *
 * `evaluateReadiness` returns `Result.ok(unknownState)` when no probe is registered for the
 * tool — that's a recoverable signal, not a chain failure (the AI still gets a "no artefacts
 * detected" prompt block and proposes a fresh body).
 */
const probeReadinessUseCase = async (
  deps: ProbeReadinessLeafDeps,
  tool: AssistantTool,
  input: ProbeReadinessInput
): Promise<Result<ReadinessState, DomainError>> => {
  const result = await evaluateReadiness({ probes: deps.probes }, input.repository, tool, deps.clock());
  if (!result.ok) return Result.error(result.error);
  return Result.ok(result.value);
};

export const probeReadinessLeaf = (deps: ProbeReadinessLeafDeps, tool: AssistantTool): Element<ReadinessCtx> =>
  leaf<ReadinessCtx, ProbeReadinessInput, ReadinessState>(`probe-${tool}`, {
    useCase: {
      execute: async (input) => probeReadinessUseCase(deps, tool, input),
    },
    input: (ctx) => {
      if (ctx.repository === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-probe',
          attemptedAction: 'probe',
          message: 'probe: ctx.repository is undefined — pick-repository must run first',
        });
      }
      return { repository: ctx.repository };
    },
    output: (ctx, probedState) => ({
      ...ctx,
      entries: { ...ctx.entries, [tool]: { ...ctx.entries[tool], probedState } },
    }),
  });
