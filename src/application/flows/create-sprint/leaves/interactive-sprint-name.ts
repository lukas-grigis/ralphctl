import { Result } from '@src/domain/result.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { CreateSprintCtx } from '@src/application/flows/create-sprint/ctx.ts';

export interface InteractiveSprintNameDeps {
  readonly interactive: InteractivePrompt;
}

interface LeafOutput {
  readonly name: string;
}

/**
 * Interactive leaf: asks the user for the sprint name. The "which repositories does this sprint
 * touch" prompt that used to live here was dropped — no downstream flow read the answer
 * (refine has no repo access by design; plan derives a per-task `projectPath` from the ticket
 * content, not from a sprint-level list; implement walks tasks). Each task now decides its own
 * repository at plan time.
 *
 * Failures from the prompt port (cancellation, malformed input) propagate verbatim.
 */
export const interactiveSprintNameLeaf = (deps: InteractiveSprintNameDeps): Element<CreateSprintCtx> =>
  leaf<CreateSprintCtx, undefined, LeafOutput>('interactive-sprint-name', {
    useCase: {
      execute: async (): Promise<Result<LeafOutput, DomainError>> => {
        const nameResult = await deps.interactive.askText('Sprint name:');
        if (!nameResult.ok) return Result.error(nameResult.error);
        const parsedName = parseRequiredString('sprint.name', nameResult.value);
        if (!parsedName.ok) return Result.error(parsedName.error);
        return Result.ok({ name: String(parsedName.value) });
      },
    },
    input: () => undefined,
    output: (ctx, out) => ({ ...ctx, sprintName: out.name }),
  });
