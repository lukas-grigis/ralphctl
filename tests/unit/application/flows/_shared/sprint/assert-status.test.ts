import { describe, expect, it } from 'vitest';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { makeActiveSprint, makeDraftSprint, makePlannedSprint } from '@tests/fixtures/domain.ts';
import {
  type AssertSprintStatusCtx,
  assertSprintStatusLeaf,
} from '@src/application/flows/_shared/sprint/assert-status.ts';

describe('assertSprintStatusLeaf', () => {
  it('passes when the loaded sprint is in an allowed status', async () => {
    const sprint = makeDraftSprint();
    const el = assertSprintStatusLeaf<AssertSprintStatusCtx>(['draft']);

    const result = await el.execute({ sprint });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx).toEqual({ sprint });
      expect(result.value.trace[0]?.elementName).toBe('assert-sprint-status');
      expect(result.value.trace[0]?.status).toBe('completed');
    }
  });

  it('passes when the sprint matches one of multiple allowed statuses', async () => {
    const planned = makePlannedSprint();
    const el = assertSprintStatusLeaf<AssertSprintStatusCtx>(['planned', 'active']);

    const result = await el.execute({ sprint: planned });
    expect(result.ok).toBe(true);
  });

  it('fails with InvalidStateError when status is not allowed', async () => {
    const active = makeActiveSprint();
    const el = assertSprintStatusLeaf<AssertSprintStatusCtx>(['draft']);

    const result = await el.execute({ sprint: active });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(InvalidStateError);
      expect(result.error.trace[0]?.status).toBe('failed');
      const err = result.error.error as InvalidStateError;
      expect(err.currentState).toBe('active');
    }
  });

  it('surfaces a missing-sprint precondition as a failed trace entry (chain wiring error)', async () => {
    const el = assertSprintStatusLeaf<AssertSprintStatusCtx>(['draft']);

    const result = await el.execute({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(InvalidStateError);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });

  it('honours a custom name in the trace (e.g. assert-draft)', async () => {
    const sprint = makeDraftSprint();
    const el = assertSprintStatusLeaf<AssertSprintStatusCtx>(['draft'], 'assert-draft');

    const result = await el.execute({ sprint });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.trace[0]?.elementName).toBe('assert-draft');
  });
});
