import { describe, expect, it } from 'vitest';
import { fromJsonAttempt } from '@src/integration/persistence/task/attempt.schema.ts';

/**
 * Schema round-trip for the new {@link CheckRun} + {@link Attribution} fields on an attempt.
 * Pre-existing attempt records (no `checkRuns` / `attribution` / `baselineBroken`) must still
 * load — the fields are optional and additive.
 */

describe('attempt schema — CheckRun round-trip', () => {
  it('parses an attempt carrying pre + post CheckRun rows', () => {
    const raw = {
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
    expect(parsed.value.checkRuns).toHaveLength(2);
    expect(parsed.value.checkRuns?.[0]?.phase).toBe('pre');
    expect(parsed.value.checkRuns?.[1]?.phase).toBe('post');
    expect(parsed.value.attribution).toBe('regressed');
  });

  it('parses an attempt with attribution="baseline-broken" + baselineBroken=true', () => {
    const raw = {
      n: 2,
      startedAt: '2026-05-08T10:00:00.000Z',
      status: 'running' as const,
      finishedAt: null,
      checkRuns: [
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

  it('parses spawn-error CheckRun with exitCode=-1', () => {
    const raw = {
      n: 1,
      startedAt: '2026-05-08T10:00:00.000Z',
      status: 'running' as const,
      finishedAt: null,
      checkRuns: [
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
    expect(parsed.value.checkRuns?.[0]?.outcome).toBe('spawn-error');
    expect(parsed.value.checkRuns?.[0]?.exitCode).toBe(-1);
    expect(parsed.value.attribution).toBeUndefined();
  });

  it('parses a pre-existing attempt with NO checkRuns / attribution (backward compat)', () => {
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
    expect(parsed.value.checkRuns).toBeUndefined();
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

  it('rejects an unknown CheckRun outcome', () => {
    const raw = {
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
          durationMs: 0,
          stdoutTailBytes: '',
          outcome: 'mystery',
        },
      ],
    };
    const parsed = fromJsonAttempt(raw);
    expect(parsed.ok).toBe(false);
  });
});
