import { Result } from '@src/domain/result.ts';
import {
  type DirtyTreeChoice,
  type DirtyTreePolicy,
  type PreflightTaskProps,
  preflightTaskUseCase,
} from '@src/business/task/preflight-task.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf, type LeafOpts } from '@src/application/chain/build/leaf.ts';
import { gitResetHard, gitStashPush, gitStatusPorcelain } from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

export type { DirtyTreePolicy };

export interface PreflightTaskLeafDeps {
  readonly gitRunner: GitRunner;
  readonly logger: Logger;
  readonly interactive: InteractivePrompt;
  readonly clock: () => IsoTimestamp;
  readonly dirtyTreePolicy?: DirtyTreePolicy;
}

interface PreflightTaskInput {
  readonly sprintId: string;
}

const ELEMENT_NAME = 'preflight-task';

/** The menu's headline, given the dirty cwd and its porcelain entry count. */
export type DirtyTreeQuestion = (input: { readonly cwd: AbsolutePath; readonly dirtyEntries: number }) => string;

const defaultQuestion: DirtyTreeQuestion = ({ cwd, dirtyEntries }) =>
  `Working tree at ${String(cwd)} has ${String(dirtyEntries)} uncommitted change(s). How do you want to handle it?`;

export interface DirtyTreeMenuOpts {
  /** Element name stamped on the `AbortError` when the operator dismisses the menu. */
  readonly elementName: string;
  readonly question?: DirtyTreeQuestion;
}

/**
 * The keep / stash / reset / cancel menu plus the git operations that carry out the answer, in
 * the function shape `preflightTaskUseCase` expects. Shared by the pre-setup preflight and the
 * post-setup tree guard so both offer the operator the identical choice — only the question
 * differs.
 */
export const dirtyTreeMenu = (
  deps: Pick<PreflightTaskLeafDeps, 'gitRunner' | 'interactive'>,
  opts: DirtyTreeMenuOpts
): Required<Pick<PreflightTaskProps, 'askDirtyTreeChoice' | 'gitStash' | 'gitReset'>> => {
  const question = opts.question ?? defaultQuestion;
  return {
    gitStash: (path, message) => gitStashPush(deps.gitRunner, path, message),
    gitReset: (path) => gitResetHard(deps.gitRunner, path),
    askDirtyTreeChoice: async (input) => {
      const choice = await deps.interactive.askChoice<DirtyTreeChoice>(question(input), [
        {
          label: 'Keep changes — proceed on the dirty tree',
          value: 'keep',
          description: 'AI may build on / overwrite the pending diff',
        },
        { label: 'Stash — save changes to a recoverable stash, then proceed', value: 'stash' },
        {
          label: 'Reset — discard all uncommitted + untracked changes, then proceed',
          value: 'reset',
          description: 'git reset --hard && git clean -fd',
        },
        { label: 'Cancel — abort the implement run', value: 'cancel' },
      ]);
      if (!choice.ok) {
        // User cancelled the menu (Ctrl-C / Esc). Surface as AbortError so the chain runner
        // treats it as explicit user cancellation rather than a configuration bug.
        return Result.error(
          new AbortError({
            elementName: opts.elementName,
            reason: `dirty-tree prompt cancelled — ${choice.error.message}`,
          })
        );
      }
      return Result.ok(choice.value);
    },
  };
};

/**
 * Chain leaf — adapts ctx → preflightTaskUseCase → ctx. Wires the gitRunner to function-shape
 * dependencies (`gitStatusEntryCount`, `gitStash`, `gitReset`) and translates the
 * `InteractivePrompt` port into the function-shape `askDirtyTreeChoice` callback the use case
 * expects. Business policy (cancel / continue / prompt) lives in
 * `@src/business/task/preflight-task.ts`.
 */
export const preflightTaskLeaf = (
  deps: PreflightTaskLeafDeps,
  cwd: AbsolutePath,
  name = 'preflight-task',
  opts?: LeafOpts
): Element<ImplementCtx> => {
  const gitStatusEntryCount: PreflightTaskProps['gitStatusEntryCount'] = async (path) => {
    const status = await gitStatusPorcelain(deps.gitRunner, path);
    if (!status.ok) return status;
    return { ok: true, value: status.value.length } as Awaited<ReturnType<PreflightTaskProps['gitStatusEntryCount']>>;
  };
  const menu = dirtyTreeMenu(deps, { elementName: ELEMENT_NAME });

  return leaf<ImplementCtx, PreflightTaskInput, void>(
    name,
    {
      useCase: {
        execute: async (input) =>
          preflightTaskUseCase({
            cwd,
            gitStatusEntryCount,
            ...menu,
            clock: deps.clock,
            sprintId: input.sprintId,
            logger: deps.logger,
            ...(deps.dirtyTreePolicy !== undefined ? { dirtyTreePolicy: deps.dirtyTreePolicy } : {}),
          }),
      },
      input: (ctx) => ({ sprintId: String(ctx.sprintId) }),
      output: (ctx) => ctx,
    },
    opts
  );
};
