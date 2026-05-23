import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const captureLogEvents = (
  bus: ReturnType<typeof createInMemoryEventBus>
): Array<{ level: string; message: string }> => {
  const captured: Array<{ level: string; message: string }> = [];
  bus.subscribe((e) => {
    if (e.type === 'log') captured.push({ level: e.level, message: e.message });
  });
  return captured;
};
import { absolutePath, isoTimestamp, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { commitTaskLeaf } from '@src/application/flows/implement/leaves/commit-task.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Task } from '@src/domain/entity/task.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');
const CWD = absolutePath('/tmp/repo');

const sprintId = ((): ImplementCtx['sprintId'] => {
  const r = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

const baseCtx = (task: Task): ImplementCtx => ({
  sprintId,
  currentTask: task,
  currentTaskId: task.id,
  tasks: [task],
});

const scriptedRunner = (
  responses: ReadonlyArray<{ args: readonly string[]; result: Result<GitRunResult, StorageError> }>
): GitRunner => {
  let i = 0;
  return {
    async run(_, args) {
      const next = responses[i++];
      if (next === undefined) throw new Error(`unscripted git ${args.join(' ')}`);
      if (JSON.stringify(next.args) !== JSON.stringify(args)) {
        throw new Error(`expected ${next.args.join(' ')} got ${args.join(' ')}`);
      }
      return next.result;
    },
  };
};

const ok = (stdout = '', exitCode = 0): Result<GitRunResult, StorageError> =>
  Result.ok({ stdout, stderr: '', exitCode });

const fakeRepo = (): UpdateTask & { calls: number } => ({
  calls: 0,
  async update() {
    (this as unknown as { calls: number }).calls += 1;
    return Result.ok(undefined);
  },
});

describe('commitTaskLeaf', () => {
  it('skips when working tree is clean', async () => {
    const repo = fakeRepo();
    const task = makeInProgressTaskWithRunningAttempt();
    const runner = scriptedRunner([{ args: ['status', '--porcelain'], result: ok('') }]);
    const leaf = commitTaskLeaf(
      { gitRunner: runner, taskRepo: repo, clock: () => NOW, logger: noopLogger },
      { cwd: CWD },
      task.id
    );
    const out = await leaf.execute(baseCtx(task));
    expect(out.ok).toBe(true);
    expect(repo.calls).toBe(0);
  });

  it('commits dirty tree, records SHA on the running attempt, and persists', async () => {
    const repo = fakeRepo();
    const sha = 'a'.repeat(40);
    const task = makeInProgressTaskWithRunningAttempt();
    const message = task.name;
    const runner = scriptedRunner([
      { args: ['status', '--porcelain'], result: ok(' M file\n') },
      { args: ['add', '-A'], result: ok() },
      { args: ['status', '--porcelain'], result: ok('M  file\n') },
      { args: ['commit', '-m', message], result: ok() },
      { args: ['rev-parse', 'HEAD'], result: ok(`${sha}\n`) },
    ]);
    const leaf = commitTaskLeaf(
      { gitRunner: runner, taskRepo: repo, clock: () => NOW, logger: noopLogger },
      { cwd: CWD },
      task.id
    );
    const out = await leaf.execute(baseCtx(task));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.ctx.lastCommitSha).toBe(sha);
      expect(out.value.ctx.currentTask?.attempts.at(-1)?.commitSha).toBe(sha);
    }
    expect(repo.calls).toBe(1);
  });

  it('FAILS the chain when commit returns non-zero — uncommitted changes must not be silently swallowed', async () => {
    // Regression: previously this leaf treated commit failures as "non-fatal" and let the
    // task settle as `done` even though its changes never landed in git. That hid pre-commit
    // hook failures and oversize-message rejections, surfaced later as a dirty worktree the
    // next sprint couldn't explain. Commit failure now propagates the StorageError so the
    // chain halts and the operator can inspect the diff.
    const eventBus = createInMemoryEventBus();
    const eventLog = captureLogEvents(eventBus);
    const logger = createEventBusLogger({ eventBus, clock: () => NOW });
    const repo = fakeRepo();
    const task = makeInProgressTaskWithRunningAttempt();
    const message = task.name;
    const runner = scriptedRunner([
      { args: ['status', '--porcelain'], result: ok(' M file\n') },
      { args: ['add', '-A'], result: ok() },
      { args: ['status', '--porcelain'], result: ok('M  file\n') },
      { args: ['commit', '-m', message], result: ok('hook rejected', 1) },
    ]);
    const leaf = commitTaskLeaf({ gitRunner: runner, taskRepo: repo, clock: () => NOW, logger }, { cwd: CWD }, task.id);
    const out = await leaf.execute(baseCtx(task));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.error.message).toMatch(/git commit failed/);
    }
    expect(eventLog.some((e) => e.level === 'error' && e.message.includes('halting chain'))).toBe(true);
    // The task was not persisted — settle won't run, the task stays in_progress.
    expect(repo.calls).toBe(0);
  });

  it('honours custom messageFactory (review chain reuse pattern)', async () => {
    const repo = fakeRepo();
    const sha = 'b'.repeat(40);
    const task = makeInProgressTaskWithRunningAttempt();
    const message = 'feedback(round-1): user-driven';
    const runner = scriptedRunner([
      { args: ['status', '--porcelain'], result: ok(' M file\n') },
      { args: ['add', '-A'], result: ok() },
      { args: ['status', '--porcelain'], result: ok('M  file\n') },
      { args: ['commit', '-m', message], result: ok() },
      { args: ['rev-parse', 'HEAD'], result: ok(`${sha}\n`) },
    ]);
    const leaf = commitTaskLeaf(
      { gitRunner: runner, taskRepo: repo, clock: () => NOW, logger: noopLogger },
      { cwd: CWD, messageFactory: () => message },
      task.id
    );
    const out = await leaf.execute(baseCtx(task));
    expect(out.ok).toBe(true);
  });

  it('uses proposedCommitMessage from ctx in preference to the default factory', async () => {
    const repo = fakeRepo();
    const task = makeInProgressTaskWithRunningAttempt();
    const sha = 'd'.repeat(40);
    let observedMessage: string | undefined;
    const runner: GitRunner = {
      async run(_, args) {
        if (args[0] === 'commit') {
          observedMessage = args[2];
          return ok();
        }
        if (args[0] === 'add') return ok();
        if (args[0] === 'status') return ok(' M file\n');
        if (args[0] === 'rev-parse') return ok(`${sha}\n`);
        throw new Error('unhandled');
      },
    };
    const leaf = commitTaskLeaf(
      { gitRunner: runner, taskRepo: repo, clock: () => NOW, logger: noopLogger },
      { cwd: CWD },
      task.id
    );
    const ctx: ImplementCtx = {
      ...baseCtx(task),
      proposedCommitMessage: { subject: 'add user-id index', body: 'Speeds up the session lookup hot path.' },
    };
    await leaf.execute(ctx);
    expect(observedMessage).toBe('add user-id index\n\nSpeeds up the session lookup hot path.');
  });

  it('uses proposedCommitMessage subject-only when no body is supplied', async () => {
    const repo = fakeRepo();
    const task = makeInProgressTaskWithRunningAttempt();
    const sha = 'e'.repeat(40);
    let observedMessage: string | undefined;
    const runner: GitRunner = {
      async run(_, args) {
        if (args[0] === 'commit') {
          observedMessage = args[2];
          return ok();
        }
        if (args[0] === 'add') return ok();
        if (args[0] === 'status') return ok(' M file\n');
        if (args[0] === 'rev-parse') return ok(`${sha}\n`);
        throw new Error('unhandled');
      },
    };
    const leaf = commitTaskLeaf(
      { gitRunner: runner, taskRepo: repo, clock: () => NOW, logger: noopLogger },
      { cwd: CWD },
      task.id
    );
    const ctx: ImplementCtx = {
      ...baseCtx(task),
      proposedCommitMessage: { subject: 'one-line message' },
    };
    await leaf.execute(ctx);
    expect(observedMessage).toBe('one-line message');
  });

  it('passes long task-name + description through verbatim (audit-[03]: no caps)', async () => {
    // Realistic AI-driven commit: long subject + multi-paragraph WHY. Commit messages are
    // signal bodies — they land verbatim on git, no truncation, no ellipsis.
    const repo = fakeRepo();
    const baseTask = makeInProgressTaskWithRunningAttempt({});
    const task: Task = {
      ...baseTask,
      name: 'Add "exphub" confetti easter egg',
      description:
        "Wire a global keyboard listener that fires a canvas-confetti burst when the user types 'exphub' anywhere on the page (excluding focused inputs/textareas), respecting prefers-reduced-motion. Reuses the existing useSecretWord hook by generalizing its hardcoded trigger words into a parameter so both the new ConfettiEasterEgg and the existing MaintainerEasterEgg share one hook.",
    };
    const sha = 'a'.repeat(40);
    let observedMessage: string | undefined;
    const runner: GitRunner = {
      async run(_, args) {
        if (args[0] === 'commit') {
          observedMessage = args[2];
          return ok();
        }
        if (args[0] === 'add') return ok();
        if (args[0] === 'status') return ok(' M file\n');
        if (args[0] === 'rev-parse') return ok(`${sha}\n`);
        throw new Error('unhandled');
      },
    };
    const leaf = commitTaskLeaf(
      { gitRunner: runner, taskRepo: repo, clock: () => NOW, logger: noopLogger },
      { cwd: CWD },
      task.id
    );
    const out = await leaf.execute(baseCtx(task));
    expect(out.ok).toBe(true);
    expect(observedMessage).toBeDefined();
    expect(observedMessage!.startsWith('Add "exphub" confetti easter egg\n\n')).toBe(true);
    expect(observedMessage!).toContain(task.description!);
    expect(observedMessage!.endsWith('...')).toBe(false);
  });

  it('passes a long proposed AI commit message through verbatim', async () => {
    const repo = fakeRepo();
    const task = makeInProgressTaskWithRunningAttempt();
    const sha = 'b'.repeat(40);
    let observedMessage: string | undefined;
    const runner: GitRunner = {
      async run(_, args) {
        if (args[0] === 'commit') {
          observedMessage = args[2];
          return ok();
        }
        if (args[0] === 'add') return ok();
        if (args[0] === 'status') return ok(' M file\n');
        if (args[0] === 'rev-parse') return ok(`${sha}\n`);
        throw new Error('unhandled');
      },
    };
    const leaf = commitTaskLeaf(
      { gitRunner: runner, taskRepo: repo, clock: () => NOW, logger: noopLogger },
      { cwd: CWD },
      task.id
    );
    const longBody = 'x'.repeat(2000);
    const ctx: ImplementCtx = {
      ...baseCtx(task),
      proposedCommitMessage: {
        subject: 'feat(easter-egg): add exphub confetti',
        body: longBody,
      },
    };
    await leaf.execute(ctx);
    expect(observedMessage).toBeDefined();
    expect(observedMessage!).toBe(`feat(easter-egg): add exphub confetti\n\n${longBody}`);
    expect(observedMessage!.endsWith('...')).toBe(false);
  });

  it('appends a deterministic `Closes <ref>` trailer when the task carries externalRefs', async () => {
    const repo = fakeRepo();
    const baseTask = makeInProgressTaskWithRunningAttempt();
    const task: Task = { ...baseTask, externalRefs: ['#123'] };
    const sha = '1'.repeat(40);
    let observedMessage: string | undefined;
    const runner: GitRunner = {
      async run(_, args) {
        if (args[0] === 'commit') {
          observedMessage = args[2];
          return ok();
        }
        if (args[0] === 'add') return ok();
        if (args[0] === 'status') return ok(' M file\n');
        if (args[0] === 'rev-parse') return ok(`${sha}\n`);
        throw new Error('unhandled');
      },
    };
    const leaf = commitTaskLeaf(
      { gitRunner: runner, taskRepo: repo, clock: () => NOW, logger: noopLogger },
      { cwd: CWD },
      task.id
    );
    const ctx: ImplementCtx = {
      ...baseCtx(task),
      proposedCommitMessage: { subject: 'feat(auth): rotate refresh tokens', body: 'WHY this matters' },
    };
    await leaf.execute(ctx);
    expect(observedMessage).toBeDefined();
    expect(observedMessage!.endsWith('\n\nCloses #123')).toBe(true);
    expect(observedMessage!.startsWith('feat(auth): rotate refresh tokens\n\n')).toBe(true);
  });

  it('renders one `Closes <ref>` line per ref for multi-ref tasks', async () => {
    const repo = fakeRepo();
    const baseTask = makeInProgressTaskWithRunningAttempt();
    const task: Task = { ...baseTask, externalRefs: ['#123', '!456'] };
    const sha = '2'.repeat(40);
    let observedMessage: string | undefined;
    const runner: GitRunner = {
      async run(_, args) {
        if (args[0] === 'commit') {
          observedMessage = args[2];
          return ok();
        }
        if (args[0] === 'add') return ok();
        if (args[0] === 'status') return ok(' M file\n');
        if (args[0] === 'rev-parse') return ok(`${sha}\n`);
        throw new Error('unhandled');
      },
    };
    const leaf = commitTaskLeaf(
      { gitRunner: runner, taskRepo: repo, clock: () => NOW, logger: noopLogger },
      { cwd: CWD },
      task.id
    );
    // No proposed message → default factory + trailer append.
    await leaf.execute(baseCtx(task));
    expect(observedMessage).toBeDefined();
    expect(observedMessage!.endsWith('\n\nCloses #123\nCloses !456')).toBe(true);
  });

  it('does not append a trailer when the task has no externalRefs', async () => {
    const repo = fakeRepo();
    const task = makeInProgressTaskWithRunningAttempt();
    const sha = '3'.repeat(40);
    let observedMessage: string | undefined;
    const runner: GitRunner = {
      async run(_, args) {
        if (args[0] === 'commit') {
          observedMessage = args[2];
          return ok();
        }
        if (args[0] === 'add') return ok();
        if (args[0] === 'status') return ok(' M file\n');
        if (args[0] === 'rev-parse') return ok(`${sha}\n`);
        throw new Error('unhandled');
      },
    };
    const leaf = commitTaskLeaf(
      { gitRunner: runner, taskRepo: repo, clock: () => NOW, logger: noopLogger },
      { cwd: CWD },
      task.id
    );
    const ctx: ImplementCtx = {
      ...baseCtx(task),
      proposedCommitMessage: { subject: 'chore: nothing fancy', body: 'no trailer please' },
    };
    await leaf.execute(ctx);
    expect(observedMessage).toBeDefined();
    expect(observedMessage).not.toContain('Closes');
    expect(observedMessage).toBe('chore: nothing fancy\n\nno trailer please');
  });

  it('appends trailer verbatim alongside a long body — no truncation', async () => {
    // Realistic shape: a long AI-written body plus the harness-appended Closes trailer.
    // Audit-[03]: nothing gets clipped at write time. Both body and trailer land intact.
    const repo = fakeRepo();
    const baseTask = makeInProgressTaskWithRunningAttempt();
    const task: Task = { ...baseTask, externalRefs: ['#9999'] };
    const sha = '4'.repeat(40);
    let observedMessage: string | undefined;
    const runner: GitRunner = {
      async run(_, args) {
        if (args[0] === 'commit') {
          observedMessage = args[2];
          return ok();
        }
        if (args[0] === 'add') return ok();
        if (args[0] === 'status') return ok(' M file\n');
        if (args[0] === 'rev-parse') return ok(`${sha}\n`);
        throw new Error('unhandled');
      },
    };
    const leaf = commitTaskLeaf(
      { gitRunner: runner, taskRepo: repo, clock: () => NOW, logger: noopLogger },
      { cwd: CWD },
      task.id
    );
    const subject = 'feat(auth): switch session lookup to user-id index';
    const body = 'x'.repeat(2000);
    const ctx: ImplementCtx = {
      ...baseCtx(task),
      proposedCommitMessage: { subject, body },
    };
    await leaf.execute(ctx);
    expect(observedMessage).toBeDefined();
    expect(observedMessage!).toBe(`${subject}\n\n${body}\n\nCloses #9999`);
    expect(observedMessage!.endsWith('...')).toBe(false);
  });

  it('appends the deterministic Closes trailer when the task carries externalRefs', async () => {
    // The AI's parse-time `commit-message` signal cannot carry the deterministic `Closes …`
    // trailer (the AI never sees the task's externalRefs). The commit-task leaf appends it
    // before invoking `git commit -m` so reviewers see the trailered message in `git log`.
    const repo = fakeRepo();
    const baseTask = makeInProgressTaskWithRunningAttempt();
    const task: Task = { ...baseTask, externalRefs: ['#128'] };
    const sha = '5'.repeat(40);
    let observedMessage: string | undefined;
    const runner: GitRunner = {
      async run(_, args) {
        if (args[0] === 'commit') {
          // `git commit -m <message>` — capture the resolved message argv passed to git.
          const mIdx = args.indexOf('-m');
          if (mIdx !== -1 && args[mIdx + 1] !== undefined) {
            observedMessage = args[mIdx + 1];
          }
          return ok();
        }
        if (args[0] === 'add') return ok();
        if (args[0] === 'status') return ok(' M file\n');
        if (args[0] === 'rev-parse') return ok(`${sha}\n`);
        throw new Error('unhandled');
      },
    };
    const leaf = commitTaskLeaf(
      { gitRunner: runner, taskRepo: repo, clock: () => NOW, logger: noopLogger },
      { cwd: CWD },
      task.id
    );
    const ctx: ImplementCtx = {
      ...baseCtx(task),
      proposedCommitMessage: { subject: 'feat(tui): show full commit message', body: 'Why this matters.' },
    };
    await leaf.execute(ctx);
    expect(observedMessage).toBeDefined();
    expect(observedMessage).toContain('Closes #128');
    // The trailer lives on its own line — never inside the subject.
    expect(observedMessage?.endsWith('\n\nCloses #128')).toBe(true);
  });
});
