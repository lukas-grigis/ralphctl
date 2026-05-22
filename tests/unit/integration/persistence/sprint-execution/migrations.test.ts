import { describe, expect, it } from 'vitest';
import { fromJsonSprintExecution } from '@src/integration/persistence/sprint-execution/sprint-execution.schema.ts';

const SPRINT_ID = '0193ed2b-1234-7abc-8def-0123456789ab';
const REPO_ID = '01900000-0000-7000-8000-00000000abcd';

describe('sprintExecutionMigrations — v0 → v1 round-trip', () => {
  it('migrates a pre-Wave-8 file whose setupRanAt rows carry stdoutTailBytes/stderrTailBytes', () => {
    const legacy = {
      // no `schemaVersion` field — pre-Wave-8 shape.
      id: SPRINT_ID,
      sprintId: SPRINT_ID,
      branch: 'feat/x',
      pullRequestUrl: null,
      setupRanAt: [
        {
          repositoryId: REPO_ID,
          ranAt: '2026-04-01T10:00:00.000Z',
          command: 'pnpm install',
          exitCode: 0,
          durationMs: 1500,
          stdoutTailBytes: 'install complete',
          stderrTailBytes: '',
          outcome: 'success',
        },
      ],
    };

    const parsed = fromJsonSprintExecution(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Domain entity shape carries no schemaVersion field.
    expect((parsed.value as unknown as Record<string, unknown>)['schemaVersion']).toBeUndefined();
    expect(parsed.value.setupRanAt).toHaveLength(1);
    const row = parsed.value.setupRanAt[0];
    expect(row?.outcome).toBe('success');
    expect(row?.command).toBe('pnpm install');
    // Wave 8: tail bytes are stripped at the migration boundary.
    expect((row as unknown as Record<string, unknown> | undefined)?.['stdoutTailBytes']).toBeUndefined();
    expect((row as unknown as Record<string, unknown> | undefined)?.['stderrTailBytes']).toBeUndefined();
  });

  it('migrates the very-early two-field row shape (just `repositoryId, ranAt`)', () => {
    const legacy = {
      id: SPRINT_ID,
      sprintId: SPRINT_ID,
      branch: null,
      pullRequestUrl: null,
      setupRanAt: [
        // pre-v0.7.0 shape — no outcome / command / exitCode.
        { repositoryId: REPO_ID, ranAt: '2026-04-01T10:00:00.000Z' },
      ],
    };
    const parsed = fromJsonSprintExecution(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const row = parsed.value.setupRanAt[0];
    expect(row?.outcome).toBe('success');
    expect(row?.command).toBe('');
    expect(row?.exitCode).toBe(0);
    expect(row?.durationMs).toBe(0);
  });

  it('migrates the legacy `sprintId`-only shape (no top-level `id`)', () => {
    const legacy = {
      sprintId: SPRINT_ID,
      branch: null,
      pullRequestUrl: null,
      setupRanAt: [],
    };
    const parsed = fromJsonSprintExecution(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(String(parsed.value.id)).toBe(SPRINT_ID);
    expect(String(parsed.value.sprintId)).toBe(SPRINT_ID);
  });

  it('parses a v1 file unchanged (no migration runs)', () => {
    const current = {
      schemaVersion: 1,
      id: SPRINT_ID,
      sprintId: SPRINT_ID,
      branch: null,
      pullRequestUrl: null,
      setupRanAt: [],
    };
    const parsed = fromJsonSprintExecution(current);
    expect(parsed.ok).toBe(true);
  });
});
