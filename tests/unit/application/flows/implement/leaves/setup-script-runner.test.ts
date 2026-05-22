import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { setupScriptRunnerLeaf } from '@src/application/flows/implement/leaves/setup-script-runner.ts';
import { createSprintExecution, type SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { SCRIPT_TAIL_BYTES } from '@src/domain/value/script-tail-bytes.ts';
import type { ShellRunOptions, ShellScriptRunner, ShellScriptResult } from '@src/integration/io/shell-script-runner.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import { absolutePath, FIXED_NOW, FIXED_REPOSITORY_ID } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';

const REPO_PATH = absolutePath('/tmp/repo');

const sprintId = ((): SprintId => {
  const id = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!id.ok) throw new Error('test setup');
  return id.value;
})();

interface SavingRepo {
  readonly save: Save<SprintExecution>['save'];
  readonly saves: SprintExecution[];
}

const savingRepo = (): SavingRepo => {
  const saves: SprintExecution[] = [];
  return {
    saves,
    async save(execution) {
      saves.push(execution);
      return Result.ok(undefined);
    },
  };
};

const failingRepo = (): SavingRepo => {
  const saves: SprintExecution[] = [];
  return {
    saves,
    async save(execution) {
      saves.push(execution);
      return Result.error(new StorageError({ subCode: 'io', message: 'disk full' }));
    },
  };
};

const passingShell = (result: Partial<ShellScriptResult> = {}): ShellScriptRunner => ({
  async run() {
    return Result.ok({
      passed: true,
      exitCode: 0,
      output: '',
      durationMs: 100,
      ...result,
    });
  },
});

const failingShell = (result: Partial<ShellScriptResult> = {}): ShellScriptRunner => ({
  async run() {
    return Result.ok({
      passed: false,
      exitCode: 1,
      output: 'something broke',
      durationMs: 50,
      ...result,
    });
  },
});

const spawnErrorShell = (message = 'spawn ENOENT'): ShellScriptRunner => ({
  async run() {
    return Result.error(new StorageError({ subCode: 'io', message: `failed to spawn shell script: ${message}` }));
  },
});

interface MultiCallShellCall {
  readonly env: NodeJS.ProcessEnv | undefined;
}

interface MultiCallShell {
  readonly runner: ShellScriptRunner;
  readonly calls: readonly MultiCallShellCall[];
}

/**
 * Per-call scripted shell. Each entry is either a `ShellScriptResult` (ok) or a `StorageError`
 * (spawn-error). Calls past the last entry throw — the test should assert the call count.
 */
const multiCallShell = (results: ReadonlyArray<Partial<ShellScriptResult> | StorageError>): MultiCallShell => {
  const calls: MultiCallShellCall[] = [];
  let i = 0;
  const runner: ShellScriptRunner = {
    async run(_cwd, _script, opts?: ShellRunOptions) {
      calls.push({ env: opts?.env });
      const next = results[i];
      i += 1;
      if (next === undefined) throw new Error(`multiCallShell: unexpected call #${String(i)}`);
      if (next instanceof StorageError) return Result.error(next);
      return Result.ok({
        passed: false,
        exitCode: 1,
        output: '',
        durationMs: 50,
        ...next,
      });
    },
  };
  return { runner, calls };
};

const baseExecution = (): SprintExecution => createSprintExecution({ sprintId });

const initialCtx = (execution: SprintExecution): ImplementCtx => ({ sprintId, execution });

describe('setupScriptRunnerLeaf', () => {
  it('records a success row when the configured script exits 0', async () => {
    const repo = savingRepo();
    const bus = createCapturingBus();
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: passingShell({ output: 'install complete', durationMs: 1500 }),
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
      }
    );

    const result = await leaf.execute(initialCtx(baseExecution()));
    if (!result.ok) throw new Error(`expected ok: ${result.error.error.message}`);

    const exec = result.value.ctx.execution as SprintExecution;
    expect(exec.setupRanAt).toHaveLength(1);
    const row = exec.setupRanAt[0];
    expect(row?.outcome).toBe('success');
    expect(row?.exitCode).toBe(0);
    expect(row?.command).toBe('pnpm install');
    expect(row?.durationMs).toBe(1500);
    expect(row?.stdoutTailBytes).toBe('install complete');
    expect(row?.stderrTailBytes).toBe('');
    expect(repo.saves).toHaveLength(1);
  });

  it('records a failed row and aborts the chain when the script exits non-zero', async () => {
    const repo = savingRepo();
    const bus = createCapturingBus();
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: failingShell({ exitCode: 7, output: 'compile error' }),
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
      }
    );

    const result = await leaf.execute(initialCtx(baseExecution()));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    // Audit row still persisted before the abort — operators can see what failed.
    expect(repo.saves).toHaveLength(1);
    const row = repo.saves[0]?.setupRanAt[0];
    expect(row?.outcome).toBe('failed');
    expect(row?.exitCode).toBe(7);
    expect(row?.stdoutTailBytes).toContain('compile error');
    // Error-level log fires so the TUI surfaces the failure.
    expect(bus.logs.some((l) => l.level === 'error' && l.message.includes('failed'))).toBe(true);
    // Tail surfacing: the leaf also publishes the last lines of script output as error-level
    // logs so the operator sees the failing line in the Recent-log tail.
    expect(bus.logs.some((l) => l.level === 'error' && l.message.includes('compile error'))).toBe(true);
    // Error message no longer repeats the repo name (the rail row already prefixes it).
    expect(result.error.error.message).toBe('exited 7');
  });

  it('surfaces a project-side hint and persists ONE row when pnpm aborts on missing TTY', async () => {
    // `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` (pnpm refuses to wipe node_modules without
    // an interactive confirmation, pnpm/pnpm#9966). The leaf does NOT auto-retry with CI=true
    // because that would flip Maven Surefire, Spring Boot @DisabledIfEnvironmentVariable("CI")
    // gates, pnpm's frozen-lockfile semantics, and other toolchain heuristics — a "green" retry
    // could mask drift from the real baseline the post-task verify gate later runs without CI.
    // Instead the leaf aborts on the single spawn and surfaces an actionable project-side hint.
    const repo = savingRepo();
    const bus = createCapturingBus();
    const shell = multiCallShell([
      { passed: false, exitCode: 1, output: 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY: stuff' },
    ]);
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: shell.runner,
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
      }
    );

    const result = await leaf.execute(initialCtx(baseExecution()));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    // Exactly one spawn — no auto-retry.
    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]?.env?.CI).toBeUndefined();
    // Exactly one audit row appended (the failed first attempt).
    expect(repo.saves).toHaveLength(1);
    const finalExec = repo.saves[repo.saves.length - 1];
    expect(finalExec?.setupRanAt).toHaveLength(1);
    expect(finalExec?.setupRanAt[0]?.outcome).toBe('failed');
    // Error message keeps the no-tty pnpm trim form.
    expect(result.error.error.message).toBe('exited 1 (no-tty pnpm)');
    // Hint surfaces the project-side fixes — no auto-retry / CI=true mention.
    const invalidStateError = result.error.error as InvalidStateError;
    const hint = invalidStateError.hint ?? '';
    expect(hint).toContain('pin pnpm < 11');
    expect(hint).toContain('confirm-modules-purge=false');
    expect(hint).not.toContain('auto-retry');
    expect(hint).not.toContain('CI=true');
  });

  it('does not append the pnpm no-TTY hint to generic script failures', async () => {
    // Regression guard for the generic-failure path: when the marker is absent the hint must
    // stay empty so an unrelated failure does not get misattributed to a pnpm/TTY issue.
    const repo = savingRepo();
    const bus = createCapturingBus();
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: failingShell({ exitCode: 2, output: 'TypeError: unrelated thing' }),
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
      }
    );

    const result = await leaf.execute(initialCtx(baseExecution()));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    // Plain "exited N" — no "(no-tty pnpm)" suffix when the marker is absent.
    expect(result.error.error.message).toBe('exited 2');
    const invalidStateError = result.error.error as InvalidStateError;
    const hint = invalidStateError.hint ?? '';
    expect(hint).not.toContain('pin pnpm < 11');
    expect(hint).not.toContain('confirm-modules-purge');
    expect(hint).not.toContain('no-TTY');
  });

  it('records a spawn-error row with exitCode -1 and aborts when the shell cannot start', async () => {
    const repo = savingRepo();
    const bus = createCapturingBus();
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: spawnErrorShell('command not found'),
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'missing-binary' }],
      }
    );

    const result = await leaf.execute(initialCtx(baseExecution()));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    expect(repo.saves).toHaveLength(1);
    const row = repo.saves[0]?.setupRanAt[0];
    expect(row?.outcome).toBe('spawn-error');
    expect(row?.exitCode).toBe(-1);
    expect(row?.command).toBe('missing-binary');
    expect(row?.stdoutTailBytes).toBe('');
    expect(row?.stderrTailBytes).toContain('command not found');
  });

  it('records a skipped row (not silent) when a repo has no setupScript', async () => {
    const repo = savingRepo();
    const bus = createCapturingBus();
    const leaf = setupScriptRunnerLeaf(
      {
        // Shell that throws if invoked — the leaf must not call run() when no script is set.
        shellScriptRunner: {
          async run() {
            throw new Error('shell must not run for skipped repos');
          },
        },
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH }],
      }
    );

    const result = await leaf.execute(initialCtx(baseExecution()));
    if (!result.ok) throw new Error('expected ok');

    const exec = result.value.ctx.execution as SprintExecution;
    expect(exec.setupRanAt).toHaveLength(1);
    const row = exec.setupRanAt[0];
    expect(row?.outcome).toBe('skipped');
    expect(row?.command).toBe('');
    expect(row?.exitCode).toBe(0);
    expect(row?.durationMs).toBe(0);
    expect(row?.stdoutTailBytes).toBe('');
    expect(row?.stderrTailBytes).toBe('');
  });

  it('surfaces a warn-level log + warn banner when a repo has no setupScript', async () => {
    // "No script configured" is a successful continuation, NOT a silent skip — the operator
    // needs to know nothing was validated. The leaf publishes a warn-tier log line for the
    // Recent-log tail and a warn-tier banner (repo-keyed id) so the dismissible banner stack
    // surfaces it.
    const repo = savingRepo();
    const bus = createCapturingBus();
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: {
          async run() {
            throw new Error('shell must not run for skipped repos');
          },
        },
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH }],
      }
    );

    const result = await leaf.execute(initialCtx(baseExecution()));
    if (!result.ok) throw new Error('expected ok');

    // Warn log lands in the bus log buffer (the tail will render it yellow).
    expect(bus.logs.some((l) => l.level === 'warn' && l.message.includes('no script configured'))).toBe(true);
    // Banner is repo-keyed so re-runs replace rather than stack indefinitely.
    const banner = bus.events.find(
      (e) => e.type === 'banner-show' && e.id === `setup-script-skipped-${String(FIXED_REPOSITORY_ID)}`
    );
    expect(banner).toBeDefined();
    if (banner?.type !== 'banner-show') throw new Error('expected banner-show');
    expect(banner.tier).toBe('warn');
    expect(banner.message).toContain('No setup script configured');
    expect(banner.message).toContain(String(REPO_PATH));
  });

  it('treats a whitespace-only setupScript as skipped', async () => {
    const repo = savingRepo();
    const bus = createCapturingBus();
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: {
          async run() {
            throw new Error('shell must not run for blank scripts');
          },
        },
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: '   \n\t  ' }],
      }
    );

    const result = await leaf.execute(initialCtx(baseExecution()));
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.ctx.execution?.setupRanAt[0]?.outcome).toBe('skipped');
  });

  it('truncates stdout tails larger than SETUP_TAIL_BYTES with a marker', async () => {
    const repo = savingRepo();
    const bus = createCapturingBus();
    const huge = 'A'.repeat(SCRIPT_TAIL_BYTES * 4) + 'FINAL_LINE';
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: passingShell({ output: huge }),
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
      }
    );

    const result = await leaf.execute(initialCtx(baseExecution()));
    if (!result.ok) throw new Error('expected ok');
    const row = result.value.ctx.execution?.setupRanAt[0];
    expect(row?.stdoutTailBytes).toContain('FINAL_LINE');
    expect(row?.stdoutTailBytes).toContain('truncated');
    // Tail body itself is capped at the limit; the marker prefix adds a small overhead.
    expect(Buffer.from(row?.stdoutTailBytes ?? '', 'utf8').length).toBeLessThan(SCRIPT_TAIL_BYTES + 200);
  });

  it('skips a repo on resume when a prior success row exists for the same command', async () => {
    // Audit [04]: setup is a sprint-start ritual. Once a prior chain on this sprint stamped a
    // `success` row for the repo under the *same* command, subsequent implement invocations
    // skip the script. The prior row stays canonical; no new row is appended.
    const repo = savingRepo();
    const bus = createCapturingBus();
    const seedExecution: SprintExecution = {
      ...baseExecution(),
      setupRanAt: [
        {
          repositoryId: FIXED_REPOSITORY_ID,
          ranAt: FIXED_NOW,
          command: 'pnpm install',
          exitCode: 0,
          durationMs: 100,
          stdoutTailBytes: '',
          stderrTailBytes: '',
          outcome: 'success',
        },
      ],
    };

    let shellCalls = 0;
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: {
          async run() {
            shellCalls += 1;
            return Result.ok({ passed: true, exitCode: 0, output: 'should not run', durationMs: 10 });
          },
        },
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
      }
    );

    const result = await leaf.execute(initialCtx(seedExecution));
    if (!result.ok) throw new Error('expected ok');

    // Shell was never invoked; no row was appended.
    expect(shellCalls).toBe(0);
    const exec = result.value.ctx.execution as SprintExecution;
    expect(exec.setupRanAt).toHaveLength(1);
    expect(repo.saves).toHaveLength(0);
    // Operator-visible log distinguishes "skipped on resume" from "skipped because no script".
    expect(bus.logs.some((l) => l.level === 'info' && l.message.includes('skipped on resume'))).toBe(true);
  });

  it('runs a repo again when its prior row is a failure (not a success)', async () => {
    // Failure does not commit the gate — the operator's fix-and-retry must re-validate.
    const repo = savingRepo();
    const bus = createCapturingBus();
    const seedExecution: SprintExecution = {
      ...baseExecution(),
      setupRanAt: [
        {
          repositoryId: FIXED_REPOSITORY_ID,
          ranAt: FIXED_NOW,
          command: 'pnpm install',
          exitCode: 1,
          durationMs: 100,
          stdoutTailBytes: 'broke',
          stderrTailBytes: '',
          outcome: 'failed',
        },
      ],
    };

    let shellCalls = 0;
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: {
          async run() {
            shellCalls += 1;
            return Result.ok({ passed: true, exitCode: 0, output: 're-ran', durationMs: 200 });
          },
        },
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
      }
    );

    const result = await leaf.execute(initialCtx(seedExecution));
    if (!result.ok) throw new Error('expected ok');

    expect(shellCalls).toBe(1);
    const exec = result.value.ctx.execution as SprintExecution;
    // Original failure row preserved; new success appended.
    expect(exec.setupRanAt).toHaveLength(2);
    expect(exec.setupRanAt[1]?.outcome).toBe('success');
  });

  it('re-runs on command drift even when a prior success exists', async () => {
    // Operator edited `project.json#setupScript` between runs — the prior success is stale.
    const repo = savingRepo();
    const bus = createCapturingBus();
    const seedExecution: SprintExecution = {
      ...baseExecution(),
      setupRanAt: [
        {
          repositoryId: FIXED_REPOSITORY_ID,
          ranAt: FIXED_NOW,
          command: 'pnpm install',
          exitCode: 0,
          durationMs: 100,
          stdoutTailBytes: '',
          stderrTailBytes: '',
          outcome: 'success',
        },
      ],
    };

    let shellCalls = 0;
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: {
          async run() {
            shellCalls += 1;
            return Result.ok({ passed: true, exitCode: 0, output: 're-ran with new cmd', durationMs: 250 });
          },
        },
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        // Operator switched to npm.
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'npm ci' }],
      }
    );

    const result = await leaf.execute(initialCtx(seedExecution));
    if (!result.ok) throw new Error('expected ok');

    expect(shellCalls).toBe(1);
    const exec = result.value.ctx.execution as SprintExecution;
    expect(exec.setupRanAt).toHaveLength(2);
    expect(exec.setupRanAt[1]?.command).toBe('npm ci');
    expect(bus.logs.some((l) => l.message.includes('configured command changed'))).toBe(true);
  });

  it('skips only the repos with prior success and runs the rest', async () => {
    // Multi-repo: setupRanAt has only repo A as success. repo B has no prior entry. The leaf
    // skips A (logs the skip) and runs B (one fresh row appended).
    const repo = savingRepo();
    const bus = createCapturingBus();
    const secondRepoId = RepositoryId.generate();
    const seedExecution: SprintExecution = {
      ...baseExecution(),
      setupRanAt: [
        {
          repositoryId: FIXED_REPOSITORY_ID,
          ranAt: FIXED_NOW,
          command: 'pnpm install',
          exitCode: 0,
          durationMs: 100,
          stdoutTailBytes: '',
          stderrTailBytes: '',
          outcome: 'success',
        },
      ],
    };

    let shellCalls = 0;
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: {
          async run(_cwd, command) {
            shellCalls += 1;
            // Only repo B's command should be invoked.
            if (command !== 'mvn install') throw new Error(`unexpected command: ${command}`);
            return Result.ok({ passed: true, exitCode: 0, output: 'maven ok', durationMs: 300 });
          },
        },
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [
          { repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' },
          { repositoryId: secondRepoId, path: absolutePath('/tmp/other'), setupScript: 'mvn install' },
        ],
      }
    );

    const result = await leaf.execute(initialCtx(seedExecution));
    if (!result.ok) throw new Error('expected ok');

    expect(shellCalls).toBe(1);
    const exec = result.value.ctx.execution as SprintExecution;
    expect(exec.setupRanAt).toHaveLength(2);
    expect(exec.setupRanAt[1]?.repositoryId).toBe(secondRepoId);
    expect(exec.setupRanAt[1]?.outcome).toBe('success');
  });

  it('aborts after the first failing repo without running subsequent repos', async () => {
    let calls = 0;
    const shell: ShellScriptRunner = {
      async run() {
        calls += 1;
        return Result.ok({ passed: false, exitCode: 1, output: 'fail', durationMs: 10 });
      },
    };
    const repo = savingRepo();
    const bus = createCapturingBus();
    const secondRepoId = RepositoryId.generate();
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: shell,
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [
          { repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'broken' },
          { repositoryId: secondRepoId, path: absolutePath('/tmp/other'), setupScript: 'also' },
        ],
      }
    );

    const result = await leaf.execute(initialCtx(baseExecution()));
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
    // Only the failed repo got a row; the second never ran.
    expect(repo.saves[repo.saves.length - 1]?.setupRanAt).toHaveLength(1);
  });

  it('continues the run when audit-stamp persistence fails (the script outcome is what matters)', async () => {
    const repo = failingRepo();
    const bus = createCapturingBus();
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: passingShell(),
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      {
        repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
      }
    );

    const result = await leaf.execute(initialCtx(baseExecution()));
    // Persistence failure is non-fatal — chain still completes.
    expect(result.ok).toBe(true);
    expect(bus.logs.some((l) => l.level === 'warn' && l.message.includes('audit persist failed'))).toBe(true);
  });
});
