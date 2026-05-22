import { describe, expect, it } from 'vitest';
import { fromJsonAttempt } from '@src/integration/persistence/task/attempt.schema.ts';
import { fromJsonTasksFile } from '@src/integration/persistence/task/task.schema.ts';

/**
 * Schema round-trip for {@link VerifyRun} + {@link Attribution} fields on an attempt.
 * Pre-existing attempt records (no `verifyRuns` / `attribution` / `baselineBroken`) must still
 * load — the fields are optional and additive.
 */

describe('attempt schema — VerifyRun round-trip', () => {
  it('parses an attempt carrying pre + post VerifyRun rows', () => {
    const raw = {
      n: 1,
      startedAt: '2026-05-08T10:00:00.000Z',
      status: 'running' as const,
      finishedAt: null,
      verifyRuns: [
        {
          phase: 'pre',
          ranAt: '2026-05-08T10:00:00.000Z',
          command: 'pnpm test',
          exitCode: 0,
          durationMs: 100,
          stdoutTailBytes: 'OK',
          outcome: 'success',
        },
        {
          phase: 'post',
          ranAt: '2026-05-08T10:01:00.000Z',
          command: 'pnpm test',
          exitCode: 1,
          durationMs: 200,
          stdoutTailBytes: 'FAILED',
          outcome: 'failed',
        },
      ],
      attribution: 'regressed' as const,
      baselineBroken: false,
    };
    const parsed = fromJsonAttempt(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.verifyRuns).toHaveLength(2);
    expect(parsed.value.verifyRuns?.[0]?.phase).toBe('pre');
    expect(parsed.value.verifyRuns?.[1]?.phase).toBe('post');
    expect(parsed.value.attribution).toBe('regressed');
  });

  it('parses an attempt with attribution="baseline-broken" + baselineBroken=true', () => {
    const raw = {
      n: 2,
      startedAt: '2026-05-08T10:00:00.000Z',
      status: 'running' as const,
      finishedAt: null,
      verifyRuns: [
        {
          phase: 'pre',
          ranAt: '2026-05-08T10:00:00.000Z',
          command: 'pnpm test',
          exitCode: 3,
          durationMs: 100,
          stdoutTailBytes: 'broken',
          outcome: 'failed',
        },
      ],
      attribution: 'baseline-broken' as const,
      baselineBroken: true,
    };
    const parsed = fromJsonAttempt(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.baselineBroken).toBe(true);
    expect(parsed.value.attribution).toBe('baseline-broken');
  });

  it('parses spawn-error VerifyRun with exitCode=-1', () => {
    const raw = {
      n: 1,
      startedAt: '2026-05-08T10:00:00.000Z',
      status: 'running' as const,
      finishedAt: null,
      verifyRuns: [
        {
          phase: 'pre',
          ranAt: '2026-05-08T10:00:00.000Z',
          command: 'missing-binary',
          exitCode: -1,
          durationMs: 0,
          stdoutTailBytes: 'spawn ENOENT',
          outcome: 'spawn-error',
        },
      ],
    };
    const parsed = fromJsonAttempt(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.verifyRuns?.[0]?.outcome).toBe('spawn-error');
    expect(parsed.value.verifyRuns?.[0]?.exitCode).toBe(-1);
    expect(parsed.value.attribution).toBeUndefined();
  });

  it('parses a pre-existing attempt with NO verifyRuns / attribution (backward compat)', () => {
    const raw = {
      n: 1,
      startedAt: '2026-05-08T10:00:00.000Z',
      status: 'verified' as const,
      finishedAt: '2026-05-08T10:01:00.000Z',
      verification: {},
    };
    const parsed = fromJsonAttempt(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.verifyRuns).toBeUndefined();
    expect(parsed.value.attribution).toBeUndefined();
    expect(parsed.value.baselineBroken).toBeUndefined();
  });

  it('rejects an unknown attribution value', () => {
    const raw = {
      n: 1,
      startedAt: '2026-05-08T10:00:00.000Z',
      status: 'running' as const,
      finishedAt: null,
      attribution: 'something-new',
    };
    const parsed = fromJsonAttempt(raw);
    expect(parsed.ok).toBe(false);
  });

  it('rejects an unknown VerifyRun outcome', () => {
    const raw = {
      n: 1,
      startedAt: '2026-05-08T10:00:00.000Z',
      status: 'running' as const,
      finishedAt: null,
      verifyRuns: [
        {
          phase: 'pre',
          ranAt: '2026-05-08T10:00:00.000Z',
          command: 'pnpm test',
          exitCode: 0,
          durationMs: 0,
          stdoutTailBytes: '',
          outcome: 'mystery',
        },
      ],
    };
    const parsed = fromJsonAttempt(raw);
    expect(parsed.ok).toBe(false);
  });

  // ── legacy on-disk migration ──────────────────────────────────────────────────────────
  // The pre-v0.7.0 `checkRuns` → `verifyRuns` lift used to live on the attempt schema's
  // own transform. Wave 8 moved it to the tasks-file migration chain (`migrations[0]`),
  // along with the `stdoutTailBytes` removal — both target the same row shape, so they
  // share one step. The test exercises the migration via `fromJsonTasksFile`.
  it('migrates legacy `checkRuns` field to `verifyRuns` and drops `stdoutTailBytes` (pre-Wave-8 records)', () => {
    const raw = [
      {
        id: '01900000-0000-7000-8000-000000000001',
        name: 'task-a',
        steps: [],
        verificationCriteria: [],
        order: 1,
        ticketId: '01900000-0000-7000-8000-000000000002',
        dependsOn: [],
        repositoryId: '01900000-0000-7000-8000-00000000abcd',
        status: 'todo' as const,
        attempts: [
          {
            n: 1,
            startedAt: '2026-05-08T10:00:00.000Z',
            status: 'running' as const,
            finishedAt: null,
            checkRuns: [
              {
                phase: 'pre',
                ranAt: '2026-05-08T10:00:00.000Z',
                command: 'pnpm test',
                exitCode: 0,
                durationMs: 100,
                stdoutTailBytes: 'OK',
                outcome: 'success',
              },
            ],
          },
        ],
      },
    ];
    const parsed = fromJsonTasksFile(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(1);
    const task = parsed.value[0];
    if (task === undefined) throw new Error('expected task');
    expect(task.attempts).toHaveLength(1);
    const att = task.attempts[0];
    if (att === undefined) throw new Error('expected attempt');
    expect(att.verifyRuns).toHaveLength(1);
    expect(att.verifyRuns?.[0]?.command).toBe('pnpm test');
    // Legacy `checkRuns` alias dropped; embedded tail bytes dropped.
    expect((att as { checkRuns?: unknown }).checkRuns).toBeUndefined();
    expect(
      (att.verifyRuns?.[0] as unknown as Record<string, unknown> | undefined)?.['stdoutTailBytes']
    ).toBeUndefined();
  });
});
