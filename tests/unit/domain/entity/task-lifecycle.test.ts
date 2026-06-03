import { describe, expect, it } from 'vitest';
import {
  BLOCKED_UPSTREAM_REASON_PREFIX,
  isUpstreamBlocked,
  markTaskBlocked,
  unblockTask,
} from '@src/domain/entity/task-lifecycle.ts';
import type { BlockedTask } from '@src/domain/entity/task.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

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

describe('unblockTask — drops both blockedReason and blockKind', () => {
  it('strips the blocked-only fields when resetting to todo', () => {
    const back = unblockTask(block(`${BLOCKED_UPSTREAM_REASON_PREFIX} — dep`, 'upstream'));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('todo');
    expect((back.value as unknown as Record<string, unknown>)['blockKind']).toBeUndefined();
    expect((back.value as unknown as Record<string, unknown>)['blockedReason']).toBeUndefined();
  });
});
