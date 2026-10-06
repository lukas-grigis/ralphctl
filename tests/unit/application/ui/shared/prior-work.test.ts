import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { quarantineStashMessage } from '@src/domain/value/quarantine-stash-message.ts';
import {
  askBulkPriorWork,
  askPriorWork,
  priorWorkClause,
  priorWorkQuestion,
  probeTaskQuarantine,
  type QuarantineProbe,
} from '@src/application/ui/shared/prior-work.ts';
import { makeActiveSprint, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';
import { emptyStashRunner, stashRunner } from '@tests/fixtures/stash-runner.ts';

const blocked = (
  name: string,
  cause: 'budget-exhausted' | 'generator-self-block',
  reason = 'attempt budget exhausted'
) => {
  const r = markTaskBlocked(makeTodoTask({ name }), reason, 'own', { blockCause: cause });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const present = (
  over: Partial<Extract<QuarantineProbe, { kind: 'present' }>> = {}
): Extract<QuarantineProbe, { kind: 'present' }> => ({
  kind: 'present',
  stashMessage: 'ralphctl/s/t/blocked-diff',
  entries: 1,
  stat: { files: 2, insertions: 12, deletions: 3 },
  files: [
    { path: 'src/a.ts', insertions: 10, deletions: 1 },
    { path: 'docs/x.png', insertions: 0, deletions: 0, binary: true },
  ],
  ...over,
});

const fake = (over: Partial<InteractivePrompt>): InteractivePrompt =>
  ({
    askChoice: async () => Result.error(new AbortError({ elementName: 'x', reason: 'esc' })),
    askMultiChoice: async () => Result.ok([]),
    ...over,
  }) as unknown as InteractivePrompt;

describe('probeTaskQuarantine', () => {
  const sprint = makeActiveSprint();
  const project = makeProject();
  const task = blocked('t', 'budget-exhausted');

  it('reports present with the newest entry measured', async () => {
    const runner = stashRunner({
      subject: `On main: ${quarantineStashMessage(sprint.id, task.id)}`,
      numstat: ['5\t1\tsrc/a.ts', '-\t-\tdocs/x.png'],
    });
    const probe = await probeTaskQuarantine({ gitRunner: runner }, project, sprint.id, task);
    expect(probe).toMatchObject({ kind: 'present', entries: 1, stat: { files: 2, insertions: 5, deletions: 1 } });
  });

  it('reports none when no entry carries the message, or the task has no repository', async () => {
    expect(await probeTaskQuarantine({ gitRunner: emptyStashRunner() }, project, sprint.id, task)).toEqual({
      kind: 'none',
    });
    expect(await probeTaskQuarantine({ gitRunner: emptyStashRunner() }, undefined, sprint.id, task)).toEqual({
      kind: 'none',
    });
  });

  it('maps a git failure to unknown instead of an error', async () => {
    const runner = { run: async () => Result.error(new Error('boom')) } as never;
    const probe = await probeTaskQuarantine({ gitRunner: runner }, project, sprint.id, task);
    expect(probe.kind).toBe('unknown');
  });
});

describe('priorWorkQuestion', () => {
  it('lists the recommended option first and keeps every line within 100 columns', () => {
    const task = blocked('Add retry to the HTTP client', 'budget-exhausted');
    const fresh = priorWorkQuestion(task, present(), 'fresh');
    expect(fresh.choices.map((c) => c.value)).toEqual(['fresh', 'continue']);
    expect(priorWorkQuestion(task, present(), 'continue').choices.map((c) => c.value)).toEqual(['continue', 'fresh']);
    for (const line of fresh.message.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
  });

  it('renders the body in the specified order', () => {
    const task = blocked('Add retry', 'budget-exhausted');
    const { message } = priorWorkQuestion(task, present({ entries: 2 }), 'fresh');
    expect(message.split('\n')).toEqual([
      'Unblock "Add retry" — what should its next attempt do with the rejected diff?',
      '',
      'kept in git stash: ralphctl/s/t/blocked-diff',
      '2 files +12 -3 · 2 stash entries under this name — the newest is shown · blocked: attempt budget exhausted',
      'suggested: start fresh — the diff failed review and its critique was archived',
      '',
      '  +10    -1  src/a.ts',
      '     binary  docs/x.png',
    ]);
  });

  it('suggests continue with the cause for a self-blocked task, and flags a partial stat', () => {
    const task = blocked('t', 'generator-self-block', 'needs an answer');
    const { message } = priorWorkQuestion(
      task,
      present({ stat: { files: 1, insertions: 1, deletions: 0, partial: true } }),
      'continue'
    );
    expect(message).toContain('suggested: continue — it stopped for a missing answer, not on quality');
    expect(message).toContain("untracked files not counted — this git can't list them");
  });

  it('collapses file rows past 40', () => {
    const files = Array.from({ length: 43 }, (_, i) => ({ path: `f${String(i)}.ts`, insertions: 1, deletions: 0 }));
    const { message } = priorWorkQuestion(blocked('t', 'budget-exhausted'), present({ files }), 'fresh');
    expect(message).toContain('… and 3 more files');
    expect(message).not.toContain('f40.ts');
  });
});

describe('askPriorWork', () => {
  const task = blocked('t', 'budget-exhausted');

  it('turns the answer into a decision carrying the probe facts', async () => {
    const r = await askPriorWork(fake({ askChoice: async () => Result.ok('continue') as never }), task, present());
    expect(r.value).toMatchObject({ choice: 'continue', stashMessage: 'ralphctl/s/t/blocked-diff', entries: 1 });
  });

  it('maps the Esc error Result to cancelled', async () => {
    const r = await askPriorWork(fake({}), task, present());
    expect(r.value).toBe('cancelled');
  });

  it('does not swallow a thrown AbortError', async () => {
    const throwing = fake({
      askChoice: async () => {
        throw new AbortError({ elementName: 'x', reason: 'run aborted' });
      },
    });
    await expect(askPriorWork(throwing, task, present())).rejects.toBeInstanceOf(AbortError);
  });
});

describe('askBulkPriorWork', () => {
  it('asks one multi-choice over tasks with a stash and pre-ticks the recommended-continue rows', async () => {
    const a = blocked('a', 'generator-self-block', 'q');
    const b = blocked('b', 'budget-exhausted');
    const c = blocked('c', 'budget-exhausted');
    let seen: { initial?: readonly string[]; labels: string[]; message: string } | undefined;
    const interactive = fake({
      askMultiChoice: (async (
        message: string,
        options: ReadonlyArray<{ label: string }>,
        opts?: { initial?: readonly string[] }
      ) => {
        seen = {
          ...(opts?.initial !== undefined ? { initial: opts.initial } : {}),
          labels: options.map((o) => o.label),
          message,
        };
        return Result.ok([String(b.id)]);
      }) as never,
    });
    const r = await askBulkPriorWork(
      interactive,
      [
        { task: a, probe: present() },
        { task: b, probe: present() },
        { task: c, probe: { kind: 'none' } },
      ],
      3
    );
    expect(seen?.initial).toEqual([String(a.id)]);
    expect(seen?.labels).toEqual([
      'a — 2 files +12 -3 · stopped for a missing answer',
      'b — 2 files +12 -3 · attempt budget exhausted',
    ]);
    expect(seen?.message).toContain('Unblock 3 stuck tasks — 2 left a rejected diff in git stash.');
    if (r.value === 'cancelled') throw new Error('unexpected cancel');
    expect(r.value.get(String(a.id))?.choice).toBe('fresh');
    expect(r.value.get(String(b.id))?.choice).toBe('continue');
    expect(r.value.has(String(c.id))).toBe(false);
  });

  it('asks nothing when no task has a stash, and maps Esc to cancelled', async () => {
    const t = blocked('a', 'budget-exhausted');
    const never = fake({
      askMultiChoice: (async () => {
        throw new Error('must not ask');
      }) as never,
    });
    expect((await askBulkPriorWork(never, [{ task: t, probe: { kind: 'none' } }], 1)).value).toEqual(new Map());
    const esc = fake({
      askMultiChoice: (async () => Result.error(new AbortError({ elementName: 'x', reason: 'esc' }))) as never,
    });
    expect((await askBulkPriorWork(esc, [{ task: t, probe: present() }], 1)).value).toBe('cancelled');
  });
});

describe('priorWorkClause', () => {
  it('words each outcome', () => {
    expect(priorWorkClause({ kind: 'none' }, undefined)).toBeUndefined();
    expect(priorWorkClause(present(), { stashMessage: 'm', nextAttempt: 'continue' })?.text).toBe(
      'next attempt continues from its rejected diff (2 files +12 -3)'
    );
    expect(priorWorkClause(present(), { stashMessage: 'm', nextAttempt: 'fresh' })?.text).toBe(
      'next attempt starts fresh; its rejected diff stays in git stash'
    );
    expect(priorWorkClause({ kind: 'unknown', error: 'e' }, undefined)).toEqual({
      text: "couldn't read git stash (e); a rejected diff there would be restored on the next attempt",
      warn: true,
    });
  });
});
