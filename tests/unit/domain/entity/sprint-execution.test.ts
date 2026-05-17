import { describe, expect, it } from 'vitest';
import {
  createSprintExecution,
  findExecutionSetupRun,
  recordExecutionPullRequestUrl,
  recordExecutionSetupRun,
  setExecutionBranch,
} from '@src/domain/entity/sprint-execution.ts';
import { FIXED_LATER, FIXED_NOW, FIXED_REPOSITORY_ID, isoTimestamp } from '@tests/fixtures/domain.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';

const sprintId = SprintId.generate();
const otherRepoId = RepositoryId.generate();

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
});

describe('setupRanAt upsert', () => {
  it('appends a new entry on first record', () => {
    const seed = createSprintExecution({ sprintId });
    const next = recordExecutionSetupRun(seed, FIXED_REPOSITORY_ID, FIXED_NOW);
    expect(next.setupRanAt).toEqual([{ repositoryId: FIXED_REPOSITORY_ID, ranAt: FIXED_NOW }]);
  });

  it('upserts when called again for the same repository (most-recent wins)', () => {
    const seed = createSprintExecution({ sprintId });
    const once = recordExecutionSetupRun(seed, FIXED_REPOSITORY_ID, FIXED_NOW);
    const twice = recordExecutionSetupRun(once, FIXED_REPOSITORY_ID, FIXED_LATER);
    expect(twice.setupRanAt).toHaveLength(1);
    expect(twice.setupRanAt[0]?.ranAt).toBe(FIXED_LATER);
  });

  it('keeps separate entries for different repositories', () => {
    const seed = createSprintExecution({ sprintId });
    const a = recordExecutionSetupRun(seed, FIXED_REPOSITORY_ID, FIXED_NOW);
    const b = recordExecutionSetupRun(a, otherRepoId, FIXED_NOW);
    expect(b.setupRanAt).toHaveLength(2);
  });

  it('findExecutionSetupRun returns the most recent timestamp', () => {
    const seed = createSprintExecution({ sprintId });
    const next = recordExecutionSetupRun(seed, FIXED_REPOSITORY_ID, FIXED_NOW);
    expect(findExecutionSetupRun(next, FIXED_REPOSITORY_ID)).toBe(FIXED_NOW);
    expect(findExecutionSetupRun(next, otherRepoId)).toBeUndefined();
  });

  it('survives JSON round-trip without losing the audit (regression: was a Map)', () => {
    const seed = createSprintExecution({ sprintId });
    const populated = recordExecutionSetupRun(seed, FIXED_REPOSITORY_ID, isoTimestamp('2026-01-01T00:00:00Z'));
    const roundTripped = JSON.parse(JSON.stringify(populated)) as typeof populated;
    expect(roundTripped.setupRanAt).toHaveLength(1);
    expect(roundTripped.setupRanAt[0]?.repositoryId).toBe(FIXED_REPOSITORY_ID);
  });
});
