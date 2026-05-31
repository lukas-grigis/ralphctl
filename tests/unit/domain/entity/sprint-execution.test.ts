import { describe, expect, it } from 'vitest';
import {
  appendExecutionSetupRun,
  createSprintExecution,
  recordExecutionPullRequestUrl,
  setExecutionBaselineBrokenPolicy,
  setExecutionBranch,
  type SetupRun,
} from '@src/domain/entity/sprint-execution.ts';
import { FIXED_LATER, FIXED_NOW, FIXED_REPOSITORY_ID, isoTimestamp } from '@tests/fixtures/domain.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';

const sprintId = SprintId.generate();
const otherRepoId = RepositoryId.generate();

const makeRun = (overrides: Partial<SetupRun> = {}): SetupRun => ({
  repositoryId: FIXED_REPOSITORY_ID,
  ranAt: FIXED_NOW,
  command: 'pnpm install',
  exitCode: 0,
  durationMs: 1234,
  outcome: 'success',
  ...overrides,
});

describe('SprintExecution mutators', () => {
  it('starts with empty arrays', () => {
    const e = createSprintExecution({ sprintId });
    expect(e.setupRanAt).toEqual([]);
    expect(e.branch).toBeNull();
    expect(e.pullRequestUrl).toBeNull();
  });

  it('setExecutionBranch is pure', () => {
    const seed = createSprintExecution({ sprintId });
    const branched = setExecutionBranch(seed, 'feat/x');
    expect(branched.branch).toBe('feat/x');
    expect(seed.branch).toBeNull();
  });

  it('recordExecutionPullRequestUrl validates http(s)', () => {
    const seed = createSprintExecution({ sprintId });
    const ok = recordExecutionPullRequestUrl(seed, 'https://example.com/pr/1');
    expect(ok.ok).toBe(true);
    const bad = recordExecutionPullRequestUrl(seed, 'ftp://nope');
    expect(bad.ok).toBe(false);
  });

  it('createSprintExecution leaves baselineBrokenPolicy undefined (one-shot amnesty starts cleared)', () => {
    const e = createSprintExecution({ sprintId });
    expect(e.baselineBrokenPolicy).toBeUndefined();
  });

  it('setExecutionBaselineBrokenPolicy stamps proceed, then clears back to undefined (key omitted)', () => {
    const seed = createSprintExecution({ sprintId });
    const stamped = setExecutionBaselineBrokenPolicy(seed, 'proceed');
    expect(stamped.baselineBrokenPolicy).toBe('proceed');
    expect(seed.baselineBrokenPolicy).toBeUndefined();
    const cleared = setExecutionBaselineBrokenPolicy(stamped, undefined);
    expect(cleared.baselineBrokenPolicy).toBeUndefined();
    // Key should not be present at all once cleared, so JSON round-trips drop the field.
    expect(Object.prototype.hasOwnProperty.call(cleared, 'baselineBrokenPolicy')).toBe(false);
  });
});

describe('appendExecutionSetupRun', () => {
  it('appends a new row on first record', () => {
    const seed = createSprintExecution({ sprintId });
    const run = makeRun();
    const next = appendExecutionSetupRun(seed, run);
    expect(next.setupRanAt).toEqual([run]);
  });

  it('preserves prior rows on subsequent appends (full audit history, no upsert)', () => {
    const seed = createSprintExecution({ sprintId });
    const once = appendExecutionSetupRun(seed, makeRun({ ranAt: FIXED_NOW }));
    const twice = appendExecutionSetupRun(once, makeRun({ ranAt: FIXED_LATER }));
    expect(twice.setupRanAt).toHaveLength(2);
    expect(twice.setupRanAt[0]?.ranAt).toBe(FIXED_NOW);
    expect(twice.setupRanAt[1]?.ranAt).toBe(FIXED_LATER);
  });

  it('preserves rows for different repositories independently', () => {
    const seed = createSprintExecution({ sprintId });
    const a = appendExecutionSetupRun(seed, makeRun({ repositoryId: FIXED_REPOSITORY_ID }));
    const b = appendExecutionSetupRun(a, makeRun({ repositoryId: otherRepoId }));
    expect(b.setupRanAt).toHaveLength(2);
    expect(b.setupRanAt[0]?.repositoryId).toBe(FIXED_REPOSITORY_ID);
    expect(b.setupRanAt[1]?.repositoryId).toBe(otherRepoId);
  });

  it('preserves the full structured row on JSON round-trip (regression: was a Map)', () => {
    const seed = createSprintExecution({ sprintId });
    const populated = appendExecutionSetupRun(
      seed,
      makeRun({ ranAt: isoTimestamp('2026-01-01T00:00:00Z'), outcome: 'failed', exitCode: 1 })
    );
    const roundTripped = JSON.parse(JSON.stringify(populated)) as typeof populated;
    expect(roundTripped.setupRanAt).toHaveLength(1);
    expect(roundTripped.setupRanAt[0]?.outcome).toBe('failed');
    expect(roundTripped.setupRanAt[0]?.exitCode).toBe(1);
    expect(roundTripped.setupRanAt[0]?.command).toBe('pnpm install');
  });

  it('records a spawn-error row with exitCode -1', () => {
    const seed = createSprintExecution({ sprintId });
    const next = appendExecutionSetupRun(
      seed,
      makeRun({
        outcome: 'spawn-error',
        exitCode: -1,
        command: 'missing-binary',
      })
    );
    const row = next.setupRanAt[0];
    expect(row?.outcome).toBe('spawn-error');
    expect(row?.exitCode).toBe(-1);
    expect(row?.command).toBe('missing-binary');
  });

  it('records a skipped row with empty command for repos without a setup script', () => {
    const seed = createSprintExecution({ sprintId });
    const next = appendExecutionSetupRun(seed, makeRun({ outcome: 'skipped', command: '', durationMs: 0 }));
    const row = next.setupRanAt[0];
    expect(row?.outcome).toBe('skipped');
    expect(row?.command).toBe('');
    expect(row?.durationMs).toBe(0);
  });
});
