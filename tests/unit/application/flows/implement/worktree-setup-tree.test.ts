import { describe, expect, it } from 'vitest';

import type { SetupTreeOutcome, SetupTreeRecord } from '@src/domain/entity/sprint-execution.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { DirtyTreePolicy } from '@src/business/task/preflight-task.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import type { PorcelainEntry } from '@src/integration/io/git-tree-snapshot.ts';
import {
  beginWorktreeSetupTreeCheck,
  worktreeSetupDirtAction,
  type WorktreeTreeVerdict,
} from '@src/application/flows/implement/worktree-setup-tree.ts';

import { absolutePath, FIXED_NOW } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { scriptedWorktreeTree, type ScriptedWorktreeTreeOpts } from '@tests/fixtures/implement-parallel.ts';

const record = (seenPaths: readonly string[], extra: Partial<SetupTreeRecord> = {}): SetupTreeRecord => ({
  outcome: 'kept',
  seenPaths,
  seenPathsTruncated: false,
  ...extra,
});

const lock: PorcelainEntry = { xy: ' M', path: 'pnpm-lock.yaml' };
const POLICIES: readonly DirtyTreePolicy[] = ['prompt', 'cancel', 'continue'];
const OUTCOMES: readonly SetupTreeOutcome[] = ['unchanged', 'kept', 'stashed', 'reset'];

describe('worktreeSetupDirtAction', () => {
  describe.each(POLICIES)("policy '%s'", (policy) => {
    it.each(OUTCOMES)("discards a path the operator saw, whatever main's outcome ('%s')", (outcome) => {
      expect(worktreeSetupDirtAction(lock, record(['pnpm-lock.yaml'], { outcome }), policy)).toBe('discard');
    });

    it('blocks everything when main recorded no answer', () => {
      expect(worktreeSetupDirtAction(lock, undefined, policy)).toBe('block');
    });

    it.each(OUTCOMES)("treats an unseen path per policy, whatever main's outcome ('%s')", (outcome) => {
      const expected = policy === 'continue' ? 'keep' : 'block';
      expect(worktreeSetupDirtAction(lock, record(['other.txt'], { outcome }), policy)).toBe(expected);
    });

    it('treats an unseen path the same way when the record was cut short', () => {
      const expected = policy === 'continue' ? 'keep' : 'block';
      const truncated = record(['other.txt'], { seenPathsTruncated: true });
      expect(worktreeSetupDirtAction(lock, truncated, policy)).toBe(expected);
    });

    it('still discards a listed path when the record was cut short', () => {
      const truncated = record(['pnpm-lock.yaml'], { seenPathsTruncated: true });
      expect(worktreeSetupDirtAction(lock, truncated, policy)).toBe('discard');
    });
  });

  it('counts a file under a recorded untracked directory as seen', () => {
    const inDir: PorcelainEntry = { xy: '??', path: 'gen/types.ts' };
    expect(worktreeSetupDirtAction(inDir, record(['gen/']), 'prompt')).toBe('discard');
  });

  it('does not treat a recorded file path as a directory', () => {
    const inDir: PorcelainEntry = { xy: '??', path: 'gen/types.ts' };
    expect(worktreeSetupDirtAction(inDir, record(['gen']), 'prompt')).toBe('block');
  });

  it('does not count a directory as seen because one file inside it was', () => {
    const dir: PorcelainEntry = { xy: '??', path: 'gen/' };
    expect(worktreeSetupDirtAction(dir, record(['gen/types.ts']), 'prompt')).toBe('block');
  });

  it('discards a rename only when both of its paths were seen', () => {
    const rename: PorcelainEntry = { xy: 'R ', path: 'new.ts', origPath: 'old.ts' };
    expect(worktreeSetupDirtAction(rename, record(['new.ts', 'old.ts']), 'prompt')).toBe('discard');
    expect(worktreeSetupDirtAction(rename, record(['new.ts']), 'prompt')).toBe('block');
  });
});

const WT = '/data/sprints/s1/worktrees/wt-task';
const COMMAND = 'pnpm install';

interface CheckInput {
  readonly tree?: Omit<ScriptedWorktreeTreeOpts, 'cwd'>;
  /** What the fake setup script writes into the worktree. */
  readonly writes?: readonly string[];
  readonly policy?: DirtyTreePolicy;
  readonly record?: SetupTreeRecord;
}

const check = async (input: CheckInput) => {
  const tree = scriptedWorktreeTree({ cwd: WT, ...input.tree });
  const bus = createCapturingBus();
  const logger = createEventBusLogger({ eventBus: bus.bus, clock: () => FIXED_NOW });
  const begun = await beginWorktreeSetupTreeCheck(
    { gitRunner: tree.runner, logger },
    { cwd: absolutePath(WT), command: COMMAND, policy: input.policy ?? 'prompt', record: input.record }
  );
  if (!begun.ok) return { begun, tree, logs: bus.logs, verdict: undefined };
  for (const w of input.writes ?? []) tree.lines.add(w);
  const verdict: WorktreeTreeVerdict = await begun.value();
  return { begun, tree, logs: bus.logs, verdict };
};

const verbs = (calls: readonly string[][]): string[] => calls.map((c) => c[0] ?? '');
const blockReason = (verdict: WorktreeTreeVerdict | undefined): string =>
  verdict?.kind === 'block' ? verdict.reason : `not blocked: ${JSON.stringify(verdict)}`;

describe('beginWorktreeSetupTreeCheck', () => {
  it('proceeds without touching the tree when setup changed nothing — even with no recorded answer', async () => {
    const { verdict, tree } = await check({ tree: { initial: [' M preexisting.ts'] } });

    expect(verdict).toStrictEqual({ kind: 'proceed' });
    expect(verbs(tree.calls)).toStrictEqual(['status', 'status']);
  });

  it('discards what setup wrote when the operator already saw those paths, then proceeds', async () => {
    const { verdict, tree } = await check({
      writes: [' M pnpm-lock.yaml', '?? gen/'],
      record: record(['pnpm-lock.yaml', 'gen/'], { outcome: 'stashed' }),
    });

    expect(verdict).toStrictEqual({ kind: 'proceed' });
    expect(tree.lines.size).toBe(0);
    expect(verbs(tree.calls)).toStrictEqual(['status', 'status', 'restore', 'clean', 'status']);
  });

  it('warns about a discard, naming the paths and the way out — a later red verify may trace back to it', async () => {
    const { logs } = await check({
      writes: [' M pnpm-lock.yaml', '?? gen/'],
      record: record(['pnpm-lock.yaml', 'gen/'], { outcome: 'kept' }),
    });

    const warn = logs.find((l) => l.level === 'warn' && l.message.includes('discarded'));
    expect(warn?.message).toContain(COMMAND);
    expect(warn?.message).toContain('pnpm-lock.yaml, gen/');
    expect(warn?.message).toMatch(/git-ignored/);
    expect(warn?.message).toContain('concurrency.maxParallelTasks 1');
    expect(logs.some((l) => l.level === 'info' && l.message.includes('discarded'))).toBe(false);
  });

  it('names only the first few discarded paths and counts the rest', async () => {
    const writes = Array.from({ length: 8 }, (_, i) => `?? gen${String(i)}.ts`);
    const { logs } = await check({ writes, record: record(writes.map((w) => w.slice(3))) });

    const warn = logs.find((l) => l.level === 'warn' && l.message.includes('discarded'));
    expect(warn?.message).toContain('8 paths (gen0.ts, gen1.ts, gen2.ts, gen3.ts, gen4.ts and 3 more)');
    expect(warn?.message).not.toContain('gen5.ts');
  });

  it('discards tracked changes under a directory the record collapsed', async () => {
    const { verdict, tree } = await check({
      writes: [' M src/gen/a.ts', ' M src/gen/b.ts'],
      record: record(['src/gen/']),
    });

    expect(verdict).toStrictEqual({ kind: 'proceed' });
    expect(tree.lines.size).toBe(0);
  });

  it('leaves dirt that was in the worktree before setup alone', async () => {
    const { verdict, tree } = await check({
      tree: { initial: [' M preexisting.ts'] },
      writes: ['?? gen/'],
      record: record(['gen/', 'preexisting.ts']),
    });

    expect(verdict).toStrictEqual({ kind: 'proceed' });
    expect([...tree.lines]).toStrictEqual([' M preexisting.ts']);
    expect(tree.calls.find((c) => c[0] === 'restore')).toBeUndefined();
  });

  it('blocks on a path the operator never saw, naming the command, the path and the way out', async () => {
    const { verdict, tree } = await check({
      writes: [' M pnpm-lock.yaml'],
      record: record([], { outcome: 'unchanged' }),
    });

    const reason = blockReason(verdict);
    expect(reason).toMatch(/^worktree setup script /);
    expect(reason).toContain(COMMAND);
    expect(reason).toContain('pnpm-lock.yaml');
    expect(reason).toContain('concurrency.maxParallelTasks');
    expect(tree.calls.some((c) => c[0] === 'restore' || c[0] === 'clean')).toBe(false);
  });

  it('blocks before discarding anything when seen and unseen paths are mixed', async () => {
    const { verdict, tree } = await check({
      writes: [' M pnpm-lock.yaml', '?? surprise.txt'],
      record: record(['pnpm-lock.yaml']),
    });

    expect(blockReason(verdict)).toContain('surprise.txt');
    expect(blockReason(verdict)).not.toContain('pnpm-lock.yaml');
    expect(tree.calls.some((c) => c[0] === 'restore' || c[0] === 'clean')).toBe(false);
  });

  it("keeps an unseen path under policy 'continue', warning that the task commit will include it", async () => {
    const { verdict, tree, logs } = await check({
      writes: [' M pnpm-lock.yaml', '?? surprise.txt'],
      record: record(['pnpm-lock.yaml']),
      policy: 'continue',
    });

    expect(verdict).toStrictEqual({ kind: 'proceed' });
    expect([...tree.lines]).toStrictEqual(['?? surprise.txt']);
    const warn = logs.find((l) => l.level === 'warn' && l.message.includes('surprise.txt'));
    expect(warn?.message).toMatch(/policy=continue/);
    expect(warn?.message).toMatch(/task commit will include/);
  });

  it('blocks when main recorded no answer at all, saying so', async () => {
    const { verdict } = await check({ writes: ['?? gen/'], policy: 'continue' });

    expect(blockReason(verdict)).toMatch(/^worktree setup script /);
    expect(blockReason(verdict)).toMatch(/no recorded/);
  });

  it('says the record was cut short when an unseen path might just be missing from it', async () => {
    const { verdict } = await check({
      writes: ['?? surprise.txt'],
      record: record(['a.txt'], { seenPathsTruncated: true }),
    });

    expect(blockReason(verdict)).toMatch(/record is incomplete/);
    expect(blockReason(verdict)).toMatch(/setup runs again on the next launch/);
  });

  it('does not mention a cut when the record is complete', async () => {
    const { verdict } = await check({ writes: ['?? surprise.txt'], record: record(['a.txt']) });

    expect(blockReason(verdict)).not.toMatch(/incomplete/);
  });

  it('fails to begin when the worktree status cannot be read before setup', async () => {
    const { begun } = await check({ tree: { statusFailsOn: [1] } });

    expect(begun.ok).toBe(false);
    if (!begun.ok) expect(begun.error).toBeInstanceOf(StorageError);
  });

  it('blocks when the worktree status cannot be read after setup — never treated as clean', async () => {
    const { verdict } = await check({ tree: { statusFailsOn: [2] }, writes: [] });

    expect(blockReason(verdict)).toMatch(/^worktree setup script /);
    expect(blockReason(verdict)).toMatch(/could not be read/);
  });

  it('blocks when the discard fails', async () => {
    const { verdict } = await check({
      tree: { restoreFails: true },
      writes: [' M pnpm-lock.yaml'],
      record: record(['pnpm-lock.yaml']),
    });

    expect(blockReason(verdict)).toMatch(/^worktree setup script /);
    expect(blockReason(verdict)).toContain('did not match');
  });

  it('blocks when a discarded path is still there afterwards', async () => {
    const { verdict } = await check({
      tree: { discardIsNoop: true },
      writes: ['?? gen/'],
      record: record(['gen/']),
    });

    expect(blockReason(verdict)).toMatch(/^worktree setup script /);
    expect(blockReason(verdict)).toContain('gen/');
  });

  it('blocks when the tree cannot be re-read after the discard', async () => {
    const { verdict } = await check({
      tree: { statusFailsOn: [3] },
      writes: ['?? gen/'],
      record: record(['gen/']),
    });

    expect(blockReason(verdict)).toMatch(/could not be read/);
  });
});
