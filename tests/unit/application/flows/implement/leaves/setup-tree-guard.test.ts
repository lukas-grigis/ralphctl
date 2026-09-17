import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import {
  createSprintExecution,
  type SetupRun,
  type SetupRunOutcome,
  type SetupTreeRecord,
  type SprintExecution,
} from '@src/domain/entity/sprint-execution.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { DirtyTreePolicy } from '@src/business/task/preflight-task.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { setupScriptRunnerLeaf } from '@src/application/flows/implement/leaves/setup-script-runner.ts';
import { createSetupTreeGuard } from '@src/application/flows/implement/leaves/setup-tree-guard.ts';
import { absolutePath, FIXED_NOW, FIXED_REPOSITORY_ID } from '@tests/fixtures/domain.ts';
import { okGit } from '@tests/fixtures/git-result.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';

const REPO = absolutePath('/tmp/setup-guard-repo');
const COMMAND = 'make bootstrap';

const sprintId = ((): SprintId => {
  const id = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!id.ok) throw new Error('test setup');
  return id.value;
})();

interface Tree {
  readonly runner: GitRunner;
  readonly lines: Set<string>;
  readonly verbs: () => readonly string[];
}

/** The guard's own snapshot probe — NUL-separated records, untracked files forced on. */
const SNAPSHOT = 'status --porcelain=v1 -z --untracked-files=normal';

/**
 * Porcelain-line working tree: the setup fake writes into it, stash / reset clear it. A `-z`
 * status gets NUL-terminated records, any other status call (the stash's own dirty check) gets
 * newline-terminated ones — the formats real git prints for each.
 */
const tree = (initial: readonly string[], statusFailure?: string): Tree => {
  const lines = new Set(initial);
  const calls: string[] = [];
  const runner: GitRunner = {
    async run(_cwd, args) {
      calls.push(args.join(' '));
      if (args[0] === 'status') {
        if (statusFailure !== undefined) return okGit(statusFailure, 128);
        const terminator = args.includes('-z') ? '\0' : '\n';
        return okGit([...lines].map((l) => `${l}${terminator}`).join(''), 0);
      }
      if (args[0] === 'stash' || args[0] === 'reset' || args[0] === 'clean') {
        lines.clear();
        return okGit('', 0);
      }
      throw new Error(`unscripted git args: ${args.join(' ')}`);
    },
  };
  return { runner, lines, verbs: () => calls };
};

const setupShell = (t: Tree, writes: readonly string[], passed = true): ShellScriptRunner => ({
  async run() {
    for (const w of writes) t.lines.add(w);
    return Result.ok({ passed, exitCode: passed ? 0 : 1, output: '', durationMs: 5 });
  },
});

const throwingShell: ShellScriptRunner = {
  async run() {
    throw new Error('setup must not spawn');
  },
};

interface Prompt {
  readonly interactive: InteractivePrompt;
  readonly questions: string[];
}

const prompt = (answer?: Result<string, StorageError>): Prompt => {
  const questions: string[] = [];
  const unexpected = (): never => {
    throw new Error('unexpected prompt kind');
  };
  return {
    questions,
    interactive: {
      askText: unexpected,
      askTextArea: unexpected,
      askMultiChoice: unexpected,
      askConfirm: unexpected,
      async askChoice<T>(question: string, _options: ReadonlyArray<Choice<T>>) {
        void _options;
        questions.push(question);
        if (answer === undefined) throw new Error(`unexpected question: ${question}`);
        return answer as unknown as Result<T, StorageError>;
      },
    },
  };
};

interface RunInput {
  readonly tree: Tree;
  readonly shell: ShellScriptRunner;
  readonly prompt: Prompt;
  readonly policy?: DirtyTreePolicy;
  readonly setupScript?: string;
  readonly execution?: SprintExecution;
}

const run = async (input: RunInput) => {
  const bus = createCapturingBus();
  const logger = createEventBusLogger({ eventBus: bus.bus, clock: () => FIXED_NOW });
  const saves: SprintExecution[] = [];
  const leaf = setupScriptRunnerLeaf(
    {
      shellScriptRunner: input.shell,
      clock: () => FIXED_NOW,
      eventBus: bus.bus,
      sprintExecutionRepo: {
        save: async (execution) => {
          saves.push(execution);
          return Result.ok(undefined);
        },
      },
      logger,
      treeGuard: createSetupTreeGuard(
        { gitRunner: input.tree.runner, interactive: input.prompt.interactive, clock: () => FIXED_NOW, logger },
        { policy: input.policy ?? 'prompt', sprintId: String(sprintId) }
      ),
    },
    {
      repos: [
        {
          repositoryId: FIXED_REPOSITORY_ID,
          path: REPO,
          ...(input.setupScript !== '' ? { setupScript: input.setupScript ?? COMMAND } : {}),
        },
      ],
    }
  );
  const ctx: ImplementCtx = { sprintId, execution: input.execution ?? createSprintExecution({ sprintId }) };
  const out = await leaf.execute(ctx);
  // The row this run appended, if any — the last one in the last save.
  const savedRow = saves.at(-1)?.setupRanAt.at(-1);
  const record = out.ok ? out.value.ctx.setupTreeRecords?.get(FIXED_REPOSITORY_ID) : undefined;
  return { out, logs: bus.logs, saves, savedRow, record };
};

const successRow = (answer?: SetupTreeRecord, command = COMMAND): SetupRun => ({
  repositoryId: FIXED_REPOSITORY_ID,
  ranAt: FIXED_NOW,
  command,
  exitCode: 0,
  durationMs: 5,
  outcome: 'success',
  ...(answer !== undefined ? { tree: answer } : {}),
});

/** A non-success row. A no-script row carries an empty command, as the leaf writes it. */
const otherRow = (outcome: Exclude<SetupRunOutcome, 'success'>, command = COMMAND): SetupRun => ({
  repositoryId: FIXED_REPOSITORY_ID,
  ranAt: FIXED_NOW,
  command: outcome === 'skipped' ? '' : command,
  exitCode: { failed: 1, 'spawn-error': -1, skipped: 0 }[outcome],
  durationMs: 0,
  outcome,
});

const withRows = (...rows: readonly SetupRun[]): SprintExecution => ({
  ...createSprintExecution({ sprintId }),
  setupRanAt: rows,
});

describe('post-setup working-tree check (setup-script-runner + tree guard)', () => {
  it('asks once, naming the script, when setup dirties a clean tree', async () => {
    const t = tree([]);
    const p = prompt(Result.ok('keep'));
    const { out } = await run({ tree: t, shell: setupShell(t, ['?? gen/types.ts']), prompt: p });

    expect(out.ok).toBe(true);
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0]).toContain(COMMAND);
    expect(p.questions[0]).toContain(String(REPO));
    // A clean tree before setup: no "also covers" caveat about pre-existing changes.
    expect(p.questions[0]).not.toMatch(/already in the tree/);
    // Kept dirt stays put, and the repo does not count as freshly verified.
    expect(t.lines.has('?? gen/types.ts')).toBe(true);
    if (out.ok) expect(out.value.ctx.setupVerifiedRepoIdsThisRun).toBeUndefined();
  });

  it('does not ask when setup leaves the tree unchanged', async () => {
    const t = tree([]);
    const p = prompt();
    const { out } = await run({ tree: t, shell: setupShell(t, []), prompt: p });

    expect(out.ok).toBe(true);
    expect(p.questions).toHaveLength(0);
    // Untracked files are listed even under `status.showUntrackedFiles=no` — `git add -A` sweeps them.
    expect(t.verbs()).toStrictEqual([SNAPSHOT, SNAPSHOT]);
    if (out.ok) expect(out.value.ctx.setupVerifiedRepoIdsThisRun).toStrictEqual([FIXED_REPOSITORY_ID]);
  });

  it('does not ask about dirt that was already there when setup changed nothing', async () => {
    const t = tree([' M src/wip.ts', '?? notes.md']);
    const p = prompt();
    const { out } = await run({ tree: t, shell: setupShell(t, []), prompt: p });

    expect(out.ok).toBe(true);
    expect(p.questions).toHaveLength(0);
  });

  it('does not ask when setup only removed entries', async () => {
    const t = tree([' M src/wip.ts']);
    const p = prompt();
    const shell: ShellScriptRunner = {
      async run() {
        t.lines.clear();
        return Result.ok({ passed: true, exitCode: 0, output: '', durationMs: 5 });
      },
    };
    const { out } = await run({ tree: t, shell, prompt: p });

    expect(out.ok).toBe(true);
    expect(p.questions).toHaveLength(0);
  });

  it('asks when setup adds dirt on top of existing changes, warning that stash / reset cover both', async () => {
    const t = tree([' M src/wip.ts']);
    const p = prompt(Result.ok('stash'));
    const { out } = await run({ tree: t, shell: setupShell(t, [' M package-lock.json']), prompt: p });

    expect(out.ok).toBe(true);
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0]).toMatch(/1 new or modified entry/);
    expect(p.questions[0]).toMatch(/also cover the 1 change already in the tree before setup/);
    const stash = t.verbs().find((v) => v.startsWith('stash push -u -m '));
    expect(stash).toContain(String(sprintId));
    expect(t.lines.size).toBe(0);
  });

  it("carries out 'reset' with a hard reset and a clean", async () => {
    const t = tree([]);
    const p = prompt(Result.ok('reset'));
    const { out } = await run({ tree: t, shell: setupShell(t, ['?? gen/a.ts']), prompt: p });

    expect(out.ok).toBe(true);
    expect(t.verbs()).toContain('reset --hard HEAD');
    expect(t.verbs()).toContain('clean -fd');
    if (out.ok) expect(out.value.ctx.setupVerifiedRepoIdsThisRun).toBeUndefined();
  });

  it("'cancel' aborts the run", async () => {
    const t = tree([]);
    const p = prompt(Result.ok('cancel'));
    const { out } = await run({ tree: t, shell: setupShell(t, ['?? gen/a.ts']), prompt: p });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.error.code).toBe(ErrorCode.Aborted);
  });

  it('a dismissed menu aborts the run', async () => {
    const t = tree([]);
    const p = prompt(Result.error(new StorageError({ subCode: 'io', message: 'prompt closed' })));
    const { out } = await run({ tree: t, shell: setupShell(t, ['?? gen/a.ts']), prompt: p });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.error.code).toBe(ErrorCode.Aborted);
  });

  it("policy 'continue' proceeds without asking and logs what setup changed", async () => {
    const t = tree([]);
    const p = prompt();
    const { out, logs } = await run({
      tree: t,
      shell: setupShell(t, ['?? gen/a.ts', ' M package-lock.json']),
      prompt: p,
      policy: 'continue',
    });

    expect(out.ok).toBe(true);
    expect(p.questions).toHaveLength(0);
    const warn = logs.find((l) => l.level === 'warn' && l.message.includes(COMMAND));
    expect(warn?.message).toMatch(/2 new or modified entries/);
    expect(warn?.message).toContain('package-lock.json');
    expect(logs.some((l) => l.level === 'warn' && /proceeding \(policy=continue\)/.test(l.message))).toBe(true);
    if (out.ok) expect(out.value.ctx.setupVerifiedRepoIdsThisRun).toBeUndefined();
  });

  it("policy 'cancel' fails the run with an error naming the script", async () => {
    const t = tree([]);
    const p = prompt();
    const { out } = await run({ tree: t, shell: setupShell(t, ['?? gen/a.ts']), prompt: p, policy: 'cancel' });

    expect(out.ok).toBe(false);
    expect(p.questions).toHaveLength(0);
    if (!out.ok) {
      expect(out.error.error.code).toBe(ErrorCode.InvalidState);
      expect(out.error.error.message).toContain(COMMAND);
      expect(out.error.error.message).toContain(String(REPO));
    }
  });

  it("policy 'cancel' still passes a setup that left the tree unchanged", async () => {
    const t = tree([]);
    const { out } = await run({ tree: t, shell: setupShell(t, []), prompt: prompt(), policy: 'cancel' });
    expect(out.ok).toBe(true);
  });

  it('probes nothing when the repo has no setup script', async () => {
    const t = tree([]);
    const { out } = await run({ tree: t, shell: throwingShell, prompt: prompt(), setupScript: '' });

    expect(out.ok).toBe(true);
    expect(t.verbs()).toStrictEqual([]);
  });

  it('probes nothing when setup is skipped on resume, and carries the recorded answer forward', async () => {
    const t = tree([]);
    const recorded: SetupTreeRecord = { outcome: 'stashed', seenPaths: ['gen/a.ts'], seenPathsTruncated: false };
    const { out, record, saves } = await run({
      tree: t,
      shell: throwingShell,
      prompt: prompt(),
      execution: withRows(successRow(recorded)),
    });

    expect(out.ok).toBe(true);
    expect(t.verbs()).toStrictEqual([]);
    expect(record).toStrictEqual(recorded);
    // The resumed row stays canonical — no new row.
    expect(saves).toHaveLength(0);
    if (out.ok) expect(out.value.ctx.setupVerifiedRepoIdsThisRun).toBeUndefined();
  });

  it('runs setup again when the prior success recorded no working-tree answer', async () => {
    const t = tree([]);
    const p = prompt(Result.ok('keep'));
    const { out, logs, savedRow, record } = await run({
      tree: t,
      shell: setupShell(t, ['?? gen/a.ts']),
      prompt: p,
      execution: withRows(successRow()),
    });

    expect(out.ok).toBe(true);
    expect(logs.some((l) => /re-running — no recorded working-tree check/.test(l.message))).toBe(true);
    expect(p.questions).toHaveLength(1);
    const expected: SetupTreeRecord = { outcome: 'kept', seenPaths: ['gen/a.ts'], seenPathsTruncated: false };
    expect(savedRow?.tree).toStrictEqual(expected);
    expect(record).toStrictEqual(expected);
  });

  it('resumes from the latest success row, not an older one without an answer', async () => {
    const t = tree([]);
    const recorded: SetupTreeRecord = { outcome: 'unchanged', seenPaths: [], seenPathsTruncated: false };
    const { out, record } = await run({
      tree: t,
      shell: throwingShell,
      prompt: prompt(),
      execution: withRows(successRow(), successRow(recorded)),
    });

    expect(out.ok).toBe(true);
    expect(record).toStrictEqual(recorded);
  });

  it('runs setup again when the latest success used a different command', async () => {
    const t = tree([]);
    const recorded: SetupTreeRecord = { outcome: 'unchanged', seenPaths: [], seenPathsTruncated: false };
    const { out, savedRow } = await run({
      tree: t,
      shell: setupShell(t, []),
      prompt: prompt(),
      execution: withRows(successRow(recorded), successRow(recorded, 'make other')),
    });

    expect(out.ok).toBe(true);
    expect(savedRow?.command).toBe(COMMAND);
    expect(savedRow?.tree).toStrictEqual(recorded);
  });

  describe('resume gate — the latest run decides', () => {
    const recorded: SetupTreeRecord = { outcome: 'stashed', seenPaths: ['gen/a.ts'], seenPathsTruncated: false };

    it.each([
      ['a failed run of another command', [successRow(recorded), otherRow('failed', 'make broken-bootstrap')]],
      ['a spawn error of the same command', [successRow(recorded), otherRow('spawn-error')]],
      [
        'a failed run, even behind a later no-script row',
        [successRow(recorded), otherRow('failed'), otherRow('skipped')],
      ],
    ] as const)('runs setup again when %s followed the latest success', async (_label, rows) => {
      const t = tree([]);
      const { out, logs, savedRow, record } = await run({
        tree: t,
        shell: setupShell(t, []),
        prompt: prompt(),
        execution: withRows(...rows),
      });

      expect(out.ok).toBe(true);
      expect(logs.some((l) => /re-running — the last setup run on this sprint did not succeed/.test(l.message))).toBe(
        true
      );
      expect(savedRow).toMatchObject({ command: COMMAND, outcome: 'success' });
      // The fresh answer replaces the one the failed run made stale.
      expect(record).toStrictEqual({ outcome: 'unchanged', seenPaths: [], seenPathsTruncated: false });
    });

    it('resumes past a no-script row written after the latest success — nothing ran then', async () => {
      const t = tree([]);
      const { out, record, saves } = await run({
        tree: t,
        shell: throwingShell,
        prompt: prompt(),
        execution: withRows(successRow(recorded), otherRow('skipped')),
      });

      expect(out.ok).toBe(true);
      expect(t.verbs()).toStrictEqual([]);
      expect(record).toStrictEqual(recorded);
      expect(saves).toHaveLength(0);
    });

    it('resumes when a success followed an earlier failure', async () => {
      const t = tree([]);
      const { out, record } = await run({
        tree: t,
        shell: throwingShell,
        prompt: prompt(),
        execution: withRows(otherRow('failed'), successRow(recorded)),
      });

      expect(out.ok).toBe(true);
      expect(record).toStrictEqual(recorded);
    });

    it('runs setup again when the recorded answer is incomplete', async () => {
      const t = tree([]);
      const incomplete: SetupTreeRecord = { ...recorded, seenPathsTruncated: true };
      const { out, logs, savedRow } = await run({
        tree: t,
        shell: setupShell(t, []),
        prompt: prompt(),
        execution: withRows(successRow(incomplete)),
      });

      expect(out.ok).toBe(true);
      expect(logs.some((l) => /re-running — the recorded working-tree check is incomplete/.test(l.message))).toBe(true);
      expect(savedRow?.tree?.seenPathsTruncated).toBe(false);
    });
  });

  it('skips the post-setup probe when the script fails — the failure is what surfaces', async () => {
    const t = tree([]);
    const p = prompt();
    const { out } = await run({ tree: t, shell: setupShell(t, ['?? gen/a.ts'], false), prompt: p });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.error.code).toBe(ErrorCode.InvalidState);
    expect(p.questions).toHaveLength(0);
    expect(t.verbs()).toStrictEqual([SNAPSHOT]);
  });

  it('does not spawn setup when the pre-setup probe fails', async () => {
    const t = tree([], 'fatal: not a git repository');
    const { out } = await run({ tree: t, shell: throwingShell, prompt: prompt() });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.error).toBeInstanceOf(StorageError);
  });
});

describe('post-setup working-tree check — the recorded answer', () => {
  it.each([
    ['keep', 'kept'],
    ['stash', 'stashed'],
    ['reset', 'reset'],
  ] as const)("records the operator's '%s' as '%s' on the row and on ctx", async (answer, outcome) => {
    const t = tree([' M src/wip.ts']);
    // The pre-setup dirt is kept up front (no pre-setup menu here — the tree guard alone is under test).
    const { out, savedRow, record } = await run({
      tree: t,
      shell: setupShell(t, [' M package-lock.json', '?? gen/']),
      prompt: prompt(Result.ok(answer)),
    });

    expect(out.ok).toBe(true);
    const expected: SetupTreeRecord = {
      outcome,
      // What setup introduced first, then what was already there.
      seenPaths: ['package-lock.json', 'gen/', 'src/wip.ts'],
      seenPathsTruncated: false,
    };
    expect(savedRow?.outcome).toBe('success');
    expect(savedRow?.tree).toStrictEqual(expected);
    expect(record).toStrictEqual(expected);
  });

  it("records 'unchanged' with the dirt that was already there when setup changed nothing", async () => {
    const t = tree([' M src/wip.ts', '?? notes.md']);
    const { savedRow, record } = await run({ tree: t, shell: setupShell(t, []), prompt: prompt() });

    const expected: SetupTreeRecord = {
      outcome: 'unchanged',
      seenPaths: ['src/wip.ts', 'notes.md'],
      seenPathsTruncated: false,
    };
    expect(savedRow?.tree).toStrictEqual(expected);
    expect(record).toStrictEqual(expected);
  });

  it("records policy 'continue' as 'kept'", async () => {
    const t = tree([]);
    const { record } = await run({
      tree: t,
      shell: setupShell(t, [' M package-lock.json']),
      prompt: prompt(),
      policy: 'continue',
    });

    expect(record).toStrictEqual({ outcome: 'kept', seenPaths: ['package-lock.json'], seenPathsTruncated: false });
  });

  it('collapses more paths than the record holds into their directory, losing none', async () => {
    const t = tree([' M README.md']);
    const writes = Array.from({ length: 250 }, (_, i) => `?? gen/f${String(i).padStart(3, '0')}.ts`);
    const { record, savedRow } = await run({
      tree: t,
      shell: setupShell(t, writes),
      prompt: prompt(),
      policy: 'continue',
    });

    const expected: SetupTreeRecord = {
      outcome: 'kept',
      seenPaths: ['gen/', 'README.md'],
      seenPathsTruncated: false,
    };
    expect(record).toStrictEqual(expected);
    expect(savedRow?.tree).toStrictEqual(expected);
  });

  it('marks the record incomplete when not even top-level entries fit', async () => {
    const t = tree([]);
    const writes = Array.from({ length: 201 }, (_, i) => `?? f${String(i).padStart(3, '0')}.ts`);
    const { record } = await run({ tree: t, shell: setupShell(t, writes), prompt: prompt(), policy: 'continue' });

    expect(record?.seenPaths).toHaveLength(200);
    expect(record?.seenPaths[0]).toBe('f000.ts');
    expect(record?.seenPathsTruncated).toBe(true);
  });

  it.each([
    ['a Cancel', Result.ok('cancel')],
    ['a dismissed menu', Result.error(new StorageError({ subCode: 'io', message: 'prompt closed' }))],
  ] as const)(
    'persists the green run without an answer after %s, so the next launch asks again',
    async (_l, answer) => {
      const t = tree([]);
      const { out, savedRow } = await run({
        tree: t,
        shell: setupShell(t, ['?? gen/a.ts']),
        prompt: prompt(answer as Result<string, StorageError>),
      });

      expect(out.ok).toBe(false);
      expect(savedRow?.outcome).toBe('success');
      expect(savedRow?.tree).toBeUndefined();
    }
  );

  it("persists the green run without an answer when policy 'cancel' refuses the change", async () => {
    const t = tree([]);
    const { out, savedRow } = await run({
      tree: t,
      shell: setupShell(t, ['?? gen/a.ts']),
      prompt: prompt(),
      policy: 'cancel',
    });

    expect(out.ok).toBe(false);
    expect(savedRow?.outcome).toBe('success');
    expect(savedRow?.tree).toBeUndefined();
  });

  it('persists a red run without an answer', async () => {
    const t = tree([]);
    const { savedRow } = await run({ tree: t, shell: setupShell(t, [], false), prompt: prompt() });

    expect(savedRow?.outcome).toBe('failed');
    expect(savedRow?.tree).toBeUndefined();
  });

  it('logs introduced paths unquoted', async () => {
    const t = tree([]);
    const { logs } = await run({
      tree: t,
      shell: setupShell(t, ['?? sp ace "q".txt']),
      prompt: prompt(),
      policy: 'continue',
    });

    const warn = logs.find((l) => l.level === 'warn' && l.message.includes(COMMAND));
    expect(warn?.message).toContain('(sp ace "q".txt)');
  });
});
