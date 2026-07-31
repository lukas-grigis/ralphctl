import { Result } from '@src/domain/result.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { isSuspendedModel, suspendedModelMessage } from '@src/domain/value/settings-models/suspended-models.ts';

/**
 * Shared catalog-membership + suspension check for every provider adapter entrypoint (headless
 * `build*Args` and interactive `run`, × claude / copilot / codex — six call sites). Each used to
 * hand-roll its own two-step "known model, then not suspended" guard; the headless adapters did
 * both steps, but the interactive claude/copilot adapters only checked catalog membership and
 * silently skipped the suspension check, so a model suspended AFTER an incident (the mechanism
 * `suspended-models.ts` is deliberately kept wired for) would fail fast with an actionable
 * message under implement/evaluate but spawn and fail opaquely under refine/plan/ideate/readiness
 * on the identical model. One helper makes that drift structurally impossible to reintroduce.
 *
 * Suspension is keyed by model id (see `suspended-models.ts`) and today only ever names
 * Anthropic-family ids, so wiring this into the Codex adapters too is harmless — `isSuspendedModel`
 * simply never matches a `gpt-*` id; the call still earns its keep there as the one catalog-
 * membership check.
 *
 * `opts.entity` / `opts.attemptedAction` feed straight into the returned {@link InvalidStateError}
 * so error provenance is unchanged from each adapter's pre-existing inline check. `opts.notKnownMessage`
 * lets each call site keep its own user-facing wording (`'claude-provider: …'` vs
 * `'interactive-claude: …'`) rather than homogenising copy as a side effect of this refactor.
 */
export interface ValidateModelOptions {
  readonly entity: string;
  readonly attemptedAction: string;
  readonly notKnownMessage: string;
}

export const validateModel = (
  model: string,
  isKnownModel: (s: string) => boolean,
  opts: ValidateModelOptions
): Result<void, InvalidStateError> => {
  if (!isKnownModel(model)) {
    return Result.error(
      new InvalidStateError({
        entity: opts.entity,
        currentState: 'model-validation',
        attemptedAction: opts.attemptedAction,
        message: opts.notKnownMessage,
      })
    );
  }
  // Catalog-valid but temporarily suspended server-side — fail fast with a clear message rather
  // than dispatching a --model the provider will reject opaquely.
  if (isSuspendedModel(model)) {
    return Result.error(
      new InvalidStateError({
        entity: opts.entity,
        currentState: 'model-suspended',
        attemptedAction: opts.attemptedAction,
        message: suspendedModelMessage(model),
      })
    );
  }
  return Result.ok(undefined);
};
