import { describe, expect, it } from 'vitest';
import {
  BLOCKED_UPSTREAM_REASON_PREFIX,
  isUpstreamBlocked,
  markTaskBlocked,
  unblockTask,
} from '@src/domain/entity/task-lifecycle.ts';
import { recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
import { applyCriteriaVerdicts } from '@src/domain/entity/task-criteria.ts';
import type { BlockedTask } from '@src/domain/entity/task.ts';
import { makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';

const block = (reason: string, kind: BlockedTask['blockKind']): BlockedTask => {
  const r = markTaskBlocked(makeTodoTask(), reason, kind);
  if (!r.ok) throw new Error(`expected blocked ok: ${r.error.message}`);
  return r.value;
};

describe('markTaskBlocked — blockKind discriminant', () => {
  it('stamps the supplied blockKind onto the blocked task', () => {
    expect(block('prerequisite not done', 'upstream').blockKind).toBe('upstream');
    expect(block('verify failed', 'own').blockKind).toBe('own');
  });

  it('rejects re-blocking a non-runnable task regardless of blockKind', () => {
    const blocked = block('first block', 'own');
    const again = markTaskBlocked(blocked, 'second block', 'upstream');
    expect(again.ok).toBe(false);
  });
});

describe('isUpstreamBlocked — reads the structural discriminant, NOT the reason text', () => {
  it('is true when blockKind is upstream', () => {
    expect(isUpstreamBlocked(block(`${BLOCKED_UPSTREAM_REASON_PREFIX} — prerequisite not done`, 'upstream'))).toBe(
      true
    );
  });

  it('is false when blockKind is own', () => {
    expect(isUpstreamBlocked(block('verify failed on its own merits', 'own'))).toBe(false);
  });

  it('a self-block reason that LITERALLY starts with "blocked upstream" but is kind=own is NOT upstream', () => {
    // The fragile prefix heuristic this replaces would have mis-classified this own-failure block as
    // auto-clearable. The structural discriminant is the only source of truth.
    const masquerading = block(`${BLOCKED_UPSTREAM_REASON_PREFIX} but actually our own bug`, 'own');
    expect(masquerading.blockedReason.startsWith(BLOCKED_UPSTREAM_REASON_PREFIX)).toBe(true);
    expect(isUpstreamBlocked(masquerading)).toBe(false);
  });

  it('a todo/in_progress task is never upstream-blocked', () => {
    expect(isUpstreamBlocked(makeTodoTask())).toBe(false);
  });
});

describe('unblockTask — clean restart (drops block fields, resets budget + escalation)', () => {
  it('strips the blocked-only fields when resetting to todo', () => {
    const back = unblockTask(block(`${BLOCKED_UPSTREAM_REASON_PREFIX} — dep`, 'upstream'));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('todo');
    expect((back.value as unknown as Record<string, unknown>)['blockKind']).toBeUndefined();
    expect((back.value as unknown as Record<string, unknown>)['blockedReason']).toBeUndefined();
  });

  it('resets the attempt budget and clears model escalation so the retry gets a genuine fresh run', () => {
    // Build an own-blocked task that carries a full attempt history AND a climbed-to escalation
    // model — the exact shape that, without the reset, would hit `budget-exhausted` / `topped-out`
    // on its very first retry plateau.
    const inProgress = makeInProgressTaskWithRunningAttempt({ maxAttempts: 3 });
    const escalated = recordTaskEscalation(inProgress, 'claude-sonnet-4-6', 'claude-opus-4-8');
    if (!escalated.ok) throw escalated.error;
    const blocked = markTaskBlocked(escalated.value, 'attempt budget exhausted', 'own');
    if (!blocked.ok) throw blocked.error;
    expect(blocked.value.attempts.length).toBeGreaterThan(0);

    const back = unblockTask(blocked.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('todo');
    expect(back.value.attempts).toHaveLength(0); // fresh budget
    expect((back.value as unknown as Record<string, unknown>)['escalatedFromModel']).toBeUndefined();
    expect((back.value as unknown as Record<string, unknown>)['escalatedToModel']).toBeUndefined();
    // The cap itself (a planning field) survives — only the consumed budget resets.
    expect(back.value.maxAttempts).toBe(3);
  });

  it('drops criteriaVerdicts so stale k-of-N verdicts do not mislead the next run', () => {
    // Arrange: build an in-progress task that carries a graded verdict map.
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const withVerdicts = applyCriteriaVerdicts(inProgress, [{ id: 'C1', passed: true }]);
    expect(withVerdicts.criteriaVerdicts).toBeDefined(); // precondition: verdicts are set

    const blocked = markTaskBlocked(withVerdicts, 'eval failed', 'own');
    if (!blocked.ok) throw blocked.error;
    expect(blocked.value.criteriaVerdicts).toBeDefined(); // precondition: verdicts survive onto blocked task

    // Act
    const back = unblockTask(blocked.value);

    // Assert: clean restart must shed the stale verdict map.
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect((back.value as unknown as Record<string, unknown>)['criteriaVerdicts']).toBeUndefined();
  });
});
