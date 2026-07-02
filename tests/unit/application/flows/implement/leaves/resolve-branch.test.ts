import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { createSprintExecution, type SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import {
  resolveBranchLeaf,
  type ResolveBranchLeafDeps,
} from '@src/application/flows/implement/leaves/resolve-branch.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * The resolve-branch leaf pins the sprint's working tree to a branch on first run, asking the
 * operator how to proceed. A prompt cancellation (Ctrl-C / Esc) surfaces through the
 * InteractivePrompt port's Result channel as an AbortError — the leaf MUST propagate it verbatim
 * (carrying `ErrorCode.Aborted`) so the chain runner renders a clean abort, not a hard failure
 * banner from a re-wrapped InvalidStateError.
 */

const sprintId = (): SprintId => {
  const parsed = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!parsed.ok) throw new Error('test setup: invalid sprint id');
  return parsed.value;
};

/** First-run execution — `branch === null` triggers the interactive strategy prompt. */
const firstRunCtx = (): ImplementCtx => {
  const sid = sprintId();
  return { sprintId: sid, execution: createSprintExecution({ sprintId: sid }) };
};

const unusedGitRunner: GitRunner = {
  async run() {
    throw new Error('git should not run on the keep / abort paths');
  },
};

const savingRepo = (): Save<SprintExecution> => ({
  async save() {
    return Result.ok(undefined);
  },
});

const buildDeps = (interactive: InteractivePrompt): ResolveBranchLeafDeps => ({
  gitRunner: unusedGitRunner,
  sprintExecutionRepo: savingRepo(),
  interactive,
  logger: noopLogger,
});

/** Builds an InteractivePrompt whose askChoice / askText return scripted results. */
const scriptedInteractive = (opts: {
  readonly choice?: Result<string, DomainError>;
  readonly text?: Result<string, DomainError>;
}): InteractivePrompt => ({
  async askText() {
    return (opts.text ?? Result.ok('feature/typed')) as Result<string, DomainError>;
  },
  async askTextArea() {
    throw new Error('not used');
  },
  async askChoice<T>(_prompt: string, _options: ReadonlyArray<Choice<T>>) {
    void _prompt;
    void _options;
    return (opts.choice ?? Result.ok('keep')) as unknown as Result<T, DomainError>;
  },
  async askMultiChoice() {
    throw new Error('not used');
  },
  async askConfirm() {
    throw new Error('not used');
  },
});

describe('resolveBranchLeaf', () => {
  it('propagates the AbortError verbatim when the branch-strategy prompt is cancelled', async () => {
    const interactive = scriptedInteractive({
      choice: Result.error(new AbortError({ elementName: 'prompt', reason: 'esc' })),
    });
    const leaf = resolveBranchLeaf(buildDeps(interactive), { cwds: [] });

    const result = await leaf.execute(firstRunCtx());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
    expect(result.error.error.code).toBe(ErrorCode.Aborted);
  });

  it('propagates the AbortError verbatim when the custom-name prompt is cancelled', async () => {
    const interactive = scriptedInteractive({
      choice: Result.ok('custom'),
      text: Result.error(new AbortError({ elementName: 'prompt', reason: 'esc' })),
    });
    const leaf = resolveBranchLeaf(buildDeps(interactive), { cwds: [] });

    const result = await leaf.execute(firstRunCtx());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
    expect(result.error.error.code).toBe(ErrorCode.Aborted);
  });

  it('keep-current strategy succeeds with an empty branch and leaves expectedBranch unset', async () => {
    const interactive = scriptedInteractive({ choice: Result.ok('keep') });
    const leaf = resolveBranchLeaf(buildDeps(interactive), { cwds: [] });

    const result = await leaf.execute(firstRunCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.expectedBranch).toBeUndefined();
    expect(result.value.ctx.execution?.branch).toBe('');
  });
});
