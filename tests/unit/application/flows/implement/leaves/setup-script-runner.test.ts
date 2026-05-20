import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { setupScriptRunnerLeaf } from '@src/application/flows/implement/leaves/setup-script-runner.ts';
import { createSprintExecution, SETUP_TAIL_BYTES, type SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { ShellScriptRunner, ShellScriptResult } from '@src/integration/io/shell-script-runner.ts';
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
    const huge = 'A'.repeat(SETUP_TAIL_BYTES * 4) + 'FINAL_LINE';
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
    expect(Buffer.from(row?.stdoutTailBytes ?? '', 'utf8').length).toBeLessThan(SETUP_TAIL_BYTES + 200);
  });

  it('runs unconditionally — a pre-existing audit stamp does not skip the next run', async () => {
    // Belts-and-braces: even if the prior chain already stamped a success for this repo, we
    // must re-execute the script and append a fresh row. The seed below contains one prior
    // entry; we expect two rows after this run.
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

    const leaf = setupScriptRunnerLeaf(
      {
        shellScriptRunner: passingShell({ output: 're-ran', durationMs: 200 }),
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

    const exec = result.value.ctx.execution as SprintExecution;
    expect(exec.setupRanAt).toHaveLength(2);
    expect(exec.setupRanAt[1]?.stdoutTailBytes).toBe('re-ran');
    expect(exec.setupRanAt[1]?.durationMs).toBe(200);
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
