import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { setupScriptRunnerLeaf } from '@src/application/flows/implement/leaves/setup-script-runner.ts';
import { createSprintExecution, type SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { ShellRunOptions, ShellScriptResult, ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import { absolutePath, FIXED_NOW, FIXED_REPOSITORY_ID } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';

/** Local scale constant used to build deliberately large output fixtures (audit-[03]: no
 *  persistence-time cap on the bus emitter; the test asserts the full body lands on disk). */
const HUGE_OUTPUT_BYTES = 4096;

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
    // Audit-[06]: the audit row carries structured metadata only; no embedded tail bytes.
    expect((row as unknown as Record<string, unknown> | undefined)?.['stdoutTailBytes']).toBeUndefined();
    expect((row as unknown as Record<string, unknown> | undefined)?.['stderrTailBytes']).toBeUndefined();
    expect(repo.saves).toHaveLength(1);
  });

  // T13: a fresh green run stamps the run-scoped `setupVerifiedRepoIdsThisRun` marker so the
  // first pre-task-verify can take the fresh-setup skip. The resume-skip and no-script paths must
  // NOT stamp it (their success — if any — belongs to a prior launch / validates nothing).
  it('stamps setupVerifiedRepoIdsThisRun with the repo id when the script ran green this invocation', async () => {
    const repo = savingRepo();
    const bus = createCapturingBus();
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: passingShell({ output: 'ok', durationMs: 800 }),
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      { repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm verify' }] }
    );
    const result = await leaf.execute(initialCtx(baseExecution()));
    if (!result.ok) throw new Error(`expected ok: ${result.error.error.message}`);
    expect(result.value.ctx.setupVerifiedRepoIdsThisRun?.map(String)).toEqual([String(FIXED_REPOSITORY_ID)]);
  });

  it('does NOT stamp setupVerifiedRepoIdsThisRun on the resume-skip path (success belongs to a prior launch)', async () => {
    const repo = savingRepo();
    const bus = createCapturingBus();
    const seedExecution: SprintExecution = {
      ...baseExecution(),
      setupRanAt: [
        {
          repositoryId: FIXED_REPOSITORY_ID,
          ranAt: FIXED_NOW,
          command: 'pnpm verify',
          exitCode: 0,
          durationMs: 100,
          outcome: 'success',
        },
      ],
    };
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: passingShell({ output: 'should not run' }),
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      { repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm verify' }] }
    );
    const result = await leaf.execute(initialCtx(seedExecution));
    if (!result.ok) throw new Error('expected ok');
    // Marker absent — the resume skip means this LAUNCH did not verify the tree.
    expect(result.value.ctx.setupVerifiedRepoIdsThisRun).toBeUndefined();
  });

  it('does NOT stamp setupVerifiedRepoIdsThisRun when the repo has no setupScript (skipped — nothing validated)', async () => {
    const repo = savingRepo();
    const bus = createCapturingBus();
    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: passingShell(),
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        sprintExecutionRepo: repo,
        logger: noopLogger,
      },
      { repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH }] }
    );
    const result = await leaf.execute(initialCtx(baseExecution()));
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.ctx.setupVerifiedRepoIdsThisRun).toBeUndefined();
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
    // Error-level log fires so the TUI surfaces the failure.
    expect(bus.logs.some((l) => l.level === 'error' && l.message.includes('failed'))).toBe(true);
    // Tail surfacing: the leaf also publishes the last lines of script output as error-level
    // logs so the operator sees the failing line in the Recent-log tail.
    expect(bus.logs.some((l) => l.level === 'error' && l.message.includes('compile error'))).toBe(true);
    // Error message no longer repeats the repo name (the rail row already prefixes it).
    expect(result.error.error.message).toBe('exited 7');
  });

  it('surfaces a CI-override hint and persists ONE row when pnpm aborts on missing TTY', async () => {
    // `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` (pnpm refuses to wipe node_modules without
    // an interactive confirmation, pnpm/pnpm#9966 / #11562). The shell runner now sets CI=true
    // on every setup/verify child — the only lever that suppresses this on pnpm 11 — so this
    // path is reached only when CI is overridden in the operator's env. The leaf still does not
    // run its own CI retry; it aborts on the single spawn and surfaces an actionable hint that
    // points at the env override rather than asking the project under development to adapt.
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
    // Exactly one spawn — the leaf itself does not do a CI retry (CI=true is injected one layer
    // down, inside the shell runner, not via the leaf's opts.env).
    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]?.env?.CI).toBeUndefined();
    // Exactly one audit row appended (the failed first attempt).
    expect(repo.saves).toHaveLength(1);
    const finalExec = repo.saves[repo.saves.length - 1];
    expect(finalExec?.setupRanAt).toHaveLength(1);
    expect(finalExec?.setupRanAt[0]?.outcome).toBe('failed');
    // Error message keeps the no-tty pnpm trim form.
    expect(result.error.error.message).toBe('exited 1 (no-tty pnpm)');
    // Hint points at the env override — the harness sets CI=true, so reaching this path means
    // CI was cleared in the operator's environment. No longer asks the project to adapt.
    const invalidStateError = result.error.error as InvalidStateError;
    const hint = invalidStateError.hint ?? '';
    expect(hint).toContain('CI');
    expect(hint).toContain('resync');
    expect(hint).not.toContain('pin pnpm < 11');
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
    // Spawn-error message now lands on the abort log + banner cause; not on the audit row.
    expect(bus.logs.some((l) => l.level === 'error' && l.message.includes('command not found'))).toBe(true);
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

  it('persists structured metadata only — no embedded tail bytes on the audit row (Wave 8)', async () => {
    // Wave-8 / audit-[06]: the audit row carries structured metadata only. The full
    // untruncated body lives under `<sprintDir>/logs/setup/<repo-id>.log`; the
    // separate `logs/ persistence` describe-block covers that path.
    const repo = savingRepo();
    const bus = createCapturingBus();
    const huge = 'A'.repeat(HUGE_OUTPUT_BYTES * 4) + 'FINAL_LINE';
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
    expect(row?.outcome).toBe('success');
    // Tail-bytes fields are gone — `'stdoutTailBytes' in row` is false.
    expect((row as unknown as Record<string, unknown> | undefined)?.['stdoutTailBytes']).toBeUndefined();
    expect((row as unknown as Record<string, unknown> | undefined)?.['stderrTailBytes']).toBeUndefined();
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

  describe('logs/ persistence (audit [01] / [03])', () => {
    let dir: string;
    beforeEach(async () => {
      const raw = await mkdtemp(join(tmpdir(), 'ralphctl-setup-logs-'));
      dir = await realpath(raw);
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('writes the full untruncated output to <sprintDir>/logs/setup/<repo-id>.log on success', async () => {
      const repo = savingRepo();
      const bus = createCapturingBus();
      const sprintDir = absolutePath(dir);
      // Output deliberately larger than a few KB so the audit-row-vs-disk distinction is observable.
      const huge = 'A'.repeat(HUGE_OUTPUT_BYTES * 2) + 'FINAL_LINE';
      const leaf = setupScriptRunnerLeaf(
        {
          shellScriptRunner: passingShell({ output: huge, durationMs: 100 }),
          clock: () => FIXED_NOW,
          eventBus: bus.bus,
          sprintExecutionRepo: repo,
          logger: noopLogger,
        },
        {
          repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
          sprintDir,
        }
      );

      const result = await leaf.execute(initialCtx(baseExecution()));
      expect(result.ok).toBe(true);

      const logPath = join(dir, 'logs', 'setup', `${String(FIXED_REPOSITORY_ID)}.log`);
      const logContent = await fs.readFile(logPath, 'utf8');
      // Full body landed on disk — no truncation at the persistence boundary.
      expect(logContent.length).toBe(huge.length);
      expect(logContent).toBe(huge);
      // Wave 8 / audit-[06]: audit row carries structured metadata only — the body lives
      // on disk. TUI surfaces lazy-load via the `LogTailReader` port.
      const row = result.ok ? (result.value.ctx.execution?.setupRanAt[0] ?? undefined) : undefined;
      expect(row?.outcome).toBe('success');
      expect((row as unknown as Record<string, unknown> | undefined)?.['stdoutTailBytes']).toBeUndefined();
    });

    it('writes the full output even when the script fails', async () => {
      const repo = savingRepo();
      const bus = createCapturingBus();
      const sprintDir = absolutePath(dir);
      const leaf = setupScriptRunnerLeaf(
        {
          shellScriptRunner: failingShell({ exitCode: 1, output: 'COMPILE ERROR: cannot find module foo' }),
          clock: () => FIXED_NOW,
          eventBus: bus.bus,
          sprintExecutionRepo: repo,
          logger: noopLogger,
        },
        {
          repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
          sprintDir,
        }
      );

      const result = await leaf.execute(initialCtx(baseExecution()));
      // Failed exit aborts the chain but the log was still persisted before the abort.
      expect(result.ok).toBe(false);
      const logPath = join(dir, 'logs', 'setup', `${String(FIXED_REPOSITORY_ID)}.log`);
      const logContent = await fs.readFile(logPath, 'utf8');
      expect(logContent).toBe('COMPILE ERROR: cannot find module foo');
    });

    it('no log file written when sprintDir is omitted (legacy path)', async () => {
      const repo = savingRepo();
      const bus = createCapturingBus();
      const leaf = setupScriptRunnerLeaf(
        {
          shellScriptRunner: passingShell({ output: 'ok' }),
          clock: () => FIXED_NOW,
          eventBus: bus.bus,
          sprintExecutionRepo: repo,
          logger: noopLogger,
        },
        {
          repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
          // sprintDir omitted intentionally
        }
      );

      const result = await leaf.execute(initialCtx(baseExecution()));
      expect(result.ok).toBe(true);
      // No logs/ tree on the test dir — the leaf never tried to write.
      await expect(fs.access(join(dir, 'logs'))).rejects.toThrow();
    });
  });

  describe('banner / tail-row clip (audit-[03] display-clip markers)', () => {
    // The setup-script failure path surfaces the last 20 non-blank output lines as error-level
    // bus events. The display clip is applied at two levels:
    //
    //   1. Per-line: lines longer than 200 chars get the trailing `…` ellipsis.
    //   2. Per-count: when more than 20 non-blank lines exist, an `… N earlier line(s) elided`
    //      header row tells the operator how many lines were dropped (full body on disk).
    //
    // Clip unit is JS `String.prototype.length` (UTF-16 code units) — an explicit decision
    // documented inline at the call site. ralphctl's setup output is shell stdout (paths /
    // exit codes / npm-pnpm diagnostics); grapheme clipping via Intl.Segmenter would be
    // overkill. The tests below pin this contract for ASCII + multi-byte UTF-8 + emoji
    // inputs so a future refactor doesn't silently change the unit.

    it('appends a `…` marker to a single tail row that exceeds 200 chars', async () => {
      const repo = savingRepo();
      const bus = createCapturingBus();
      // One line, 250 chars — must be clipped + ellipsised on the bus emit.
      const longLine = 'x'.repeat(250);
      const leaf = setupScriptRunnerLeaf(
        {
          shellScriptRunner: failingShell({ exitCode: 1, output: longLine }),
          clock: () => FIXED_NOW,
          eventBus: bus.bus,
          sprintExecutionRepo: repo,
          logger: noopLogger,
        },
        {
          repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
        }
      );
      await leaf.execute(initialCtx(baseExecution()));
      const tailMessages = bus.logs.filter((l) => l.message.includes('setup-script (')).map((l) => l.message);
      const xLine = tailMessages.find((m) => m.includes('xxx'));
      expect(xLine).toBeDefined();
      // Marker present + total length within the budget + the original 250-char run
      // not rendered in full.
      expect(xLine).toContain('…');
      // The headline includes the basename + 200-char body + `…`; the original 250-char run
      // must NOT appear verbatim.
      expect(xLine).not.toContain('x'.repeat(250));
    });

    it('omits the `…` marker when a tail row fits inside 200 chars', async () => {
      const repo = savingRepo();
      const bus = createCapturingBus();
      const shortLine = 'COMPILE ERROR: cannot find module foo';
      const leaf = setupScriptRunnerLeaf(
        {
          shellScriptRunner: failingShell({ exitCode: 1, output: shortLine }),
          clock: () => FIXED_NOW,
          eventBus: bus.bus,
          sprintExecutionRepo: repo,
          logger: noopLogger,
        },
        {
          repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
        }
      );
      await leaf.execute(initialCtx(baseExecution()));
      // The tail row carries the unclipped message; no `…` glyph in the line.
      const tailRow = bus.logs.find((l) => l.message.endsWith(shortLine));
      expect(tailRow).toBeDefined();
      expect(tailRow?.message).not.toContain('…');
    });

    it('emits a multi-line elision marker when more than 20 non-blank lines exist', async () => {
      const repo = savingRepo();
      const bus = createCapturingBus();
      // 25 non-blank lines — 5 should be elided, 20 surface as tail rows.
      const many = Array.from({ length: 25 }, (_, i) => `line-${String(i + 1)}`).join('\n');
      const leaf = setupScriptRunnerLeaf(
        {
          shellScriptRunner: failingShell({ exitCode: 1, output: many }),
          clock: () => FIXED_NOW,
          eventBus: bus.bus,
          sprintExecutionRepo: repo,
          logger: noopLogger,
        },
        {
          repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
        }
      );
      await leaf.execute(initialCtx(baseExecution()));
      // The elision header must surface the exact dropped count.
      const elidedHeader = bus.logs.find((l) => l.message.includes('earlier line') && l.message.includes('elided'));
      expect(elidedHeader).toBeDefined();
      expect(elidedHeader?.message).toContain('5 earlier lines');
      // The first 5 lines are dropped; line-6..line-25 surface verbatim.
      expect(bus.logs.some((l) => l.message.includes(': line-6'))).toBe(true);
      expect(bus.logs.some((l) => l.message.includes(': line-25'))).toBe(true);
      expect(bus.logs.some((l) => l.message.endsWith(': line-1'))).toBe(false);
    });

    it('omits the multi-line elision marker when ≤20 non-blank lines exist', async () => {
      const repo = savingRepo();
      const bus = createCapturingBus();
      const few = Array.from({ length: 4 }, (_, i) => `line-${String(i + 1)}`).join('\n');
      const leaf = setupScriptRunnerLeaf(
        {
          shellScriptRunner: failingShell({ exitCode: 1, output: few }),
          clock: () => FIXED_NOW,
          eventBus: bus.bus,
          sprintExecutionRepo: repo,
          logger: noopLogger,
        },
        {
          repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
        }
      );
      await leaf.execute(initialCtx(baseExecution()));
      const elidedHeader = bus.logs.find((l) => l.message.includes('elided'));
      expect(elidedHeader).toBeUndefined();
    });

    it('clip unit is JS string code units — ASCII / multi-byte UTF-8 round-trip cleanly', async () => {
      const repo = savingRepo();
      const bus = createCapturingBus();
      // Mix ASCII + a Cyrillic word (multi-byte UTF-8, but 1 code unit per char). Total < 200
      // code units → no clip applied. The full line must appear verbatim on the bus.
      const mixed = 'compile error: модуль foo не найден';
      const leaf = setupScriptRunnerLeaf(
        {
          shellScriptRunner: failingShell({ exitCode: 1, output: mixed }),
          clock: () => FIXED_NOW,
          eventBus: bus.bus,
          sprintExecutionRepo: repo,
          logger: noopLogger,
        },
        {
          repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
        }
      );
      await leaf.execute(initialCtx(baseExecution()));
      const matched = bus.logs.find((l) => l.message.endsWith(mixed));
      expect(matched).toBeDefined();
      expect(matched?.message).not.toContain('…');
    });

    it('clip unit is JS string code units — clip fires once the 200-cu budget is exceeded (emoji input)', async () => {
      const repo = savingRepo();
      const bus = createCapturingBus();
      // Each 🎉 is one Unicode code point but 2 UTF-16 code units. 110 emoji = 220 code units,
      // which exceeds the 200-cu cap. The clip will fire and `…` must be appended. A surrogate
      // pair MAY be split mid-pair (cli-truncate / Intl.Segmenter is out of scope for this
      // emitter — see the inline comment on the call site). The contract we pin: clip applied,
      // marker present, the verbatim 110-emoji string never lands.
      const emoji = '🎉'.repeat(110);
      const leaf = setupScriptRunnerLeaf(
        {
          shellScriptRunner: failingShell({ exitCode: 1, output: emoji }),
          clock: () => FIXED_NOW,
          eventBus: bus.bus,
          sprintExecutionRepo: repo,
          logger: noopLogger,
        },
        {
          repos: [{ repositoryId: FIXED_REPOSITORY_ID, path: REPO_PATH, setupScript: 'pnpm install' }],
        }
      );
      await leaf.execute(initialCtx(baseExecution()));
      const tail = bus.logs.find((l) => l.message.includes('setup-script (') && l.message.includes('…'));
      expect(tail).toBeDefined();
      expect(tail?.message).not.toContain(emoji);
    });
  });
});
