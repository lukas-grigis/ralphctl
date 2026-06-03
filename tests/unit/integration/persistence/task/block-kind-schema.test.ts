import { describe, expect, it } from 'vitest';
import { fromJsonTask, toJsonTask } from '@src/integration/persistence/task/task.schema.ts';
import { BLOCKED_UPSTREAM_REASON_PREFIX, markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { BlockedTask } from '@src/domain/entity/task.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

/**
 * CS-1C read-time migration: `tasks.json` files written before {@link BlockedTask.blockKind} carry
 * a `blocked` task without the field. The loader infers it from the (deprecated) reason prefix —
 * `blocked upstream…` → `upstream`, anything else → `own` — and materialises it so the canonical
 * shape lands on the next save.
 */

const block = (reason: string, kind: BlockedTask['blockKind']): BlockedTask => {
  const r = markTaskBlocked(makeTodoTask(), reason, kind);
  if (!r.ok) throw new Error(`expected blocked ok: ${r.error.message}`);
  return r.value;
};

/** Build a legacy (pre-blockKind) persisted shape by stripping the field from a canonical one. */
const legacyPayloadWithReason = (reason: string): Record<string, unknown> => {
  const persisted = toJsonTask(block(reason, 'own')) as Record<string, unknown>;
  const { blockKind: _dropped, ...rest } = persisted;
  void _dropped;
  return { ...rest, blockedReason: reason };
};

describe('task.schema — blockKind read-time inference for legacy blocked entries', () => {
  it('infers upstream when the legacy reason starts with the upstream prefix', () => {
    const parsed = fromJsonTask(legacyPayloadWithReason(`${BLOCKED_UPSTREAM_REASON_PREFIX} — prerequisite not done`));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.status === 'blocked') {
      expect(parsed.value.blockKind).toBe('upstream');
    }
  });

  it('infers own for any other legacy reason', () => {
    const parsed = fromJsonTask(legacyPayloadWithReason('verify failed on its own merits'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.status === 'blocked') {
      expect(parsed.value.blockKind).toBe('own');
    }
  });

  it('does NOT infer upstream for an own-failure reason that merely starts with the prefix when blockKind is present', () => {
    // A canonical entry carries blockKind explicitly; the present value wins over the prefix.
    const persisted = toJsonTask(block(`${BLOCKED_UPSTREAM_REASON_PREFIX} but our own bug`, 'own'));
    const parsed = fromJsonTask(persisted);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.status === 'blocked') {
      expect(parsed.value.blockKind).toBe('own');
    }
  });

  it('round-trips an upstream-blocked task through save → load unchanged', () => {
    const original = block(`${BLOCKED_UPSTREAM_REASON_PREFIX} — dep`, 'upstream');
    const parsed = fromJsonTask(toJsonTask(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.status === 'blocked') {
      expect(parsed.value.blockKind).toBe('upstream');
      expect(parsed.value.blockedReason).toBe(original.blockedReason);
    }
  });

  it('round-trips an own-blocked task through save → load unchanged', () => {
    const original = block('post-task verify regressed', 'own');
    const parsed = fromJsonTask(toJsonTask(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.status === 'blocked') {
      expect(parsed.value.blockKind).toBe('own');
      expect(parsed.value.blockedReason).toBe(original.blockedReason);
    }
  });
});
