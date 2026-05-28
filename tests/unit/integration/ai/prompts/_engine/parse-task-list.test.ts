import { describe, expect, it, vi } from 'vitest';
import { parseTaskList } from '@src/integration/ai/prompts/_engine/parse-task-list.ts';
import { TicketId } from '@src/domain/value/id/ticket-id.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { FIXTURE_REPO_PATH, makeProject } from '@tests/fixtures/domain.ts';

const ticketId = (() => {
  const r = TicketId.parse('01900000-0000-7000-8000-00000000aaaa');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

const project = makeProject(); // single repo at FIXTURE_REPO_PATH

interface SpecOverrides {
  readonly id: string;
  readonly blockedBy?: readonly string[];
}

const spec = (o: SpecOverrides): unknown => ({
  id: o.id,
  name: `task ${o.id}`,
  projectPath: FIXTURE_REPO_PATH,
  steps: ['s'],
  verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
  ...(o.blockedBy !== undefined ? { blockedBy: o.blockedBy } : {}),
});

const fakeLogger = (): Logger & { calls: Array<{ level: string; message: string }> } => {
  const calls: Array<{ level: string; message: string }> = [];
  const self: Logger & { calls: typeof calls } = {
    debug: (m: string) => calls.push({ level: 'debug', message: m }),
    info: (m: string) => calls.push({ level: 'info', message: m }),
    warn: (m: string) => calls.push({ level: 'warn', message: m }),
    error: (m: string) => calls.push({ level: 'error', message: m }),
    named: vi.fn(() => self),
    calls,
  };
  return self;
};

describe("parseTaskList — topological reorder (Kahn's)", () => {
  it('already-sound emission → no-op, preserves order field, logger never fires', () => {
    // A, B blockedBy A, C blockedBy B — emitted A,B,C (already topologically sound)
    const logger = fakeLogger();
    const out = parseTaskList(
      [spec({ id: 'A' }), spec({ id: 'B', blockedBy: ['A'] }), spec({ id: 'C', blockedBy: ['B'] })],
      { project, mode: { kind: 'fixed', ticketId }, logger }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toHaveLength(3);
    expect(out.value[0]?.name).toBe('task A');
    expect(out.value[1]?.name).toBe('task B');
    expect(out.value[2]?.name).toBe('task C');
    expect(out.value[0]?.order).toBe(1);
    expect(out.value[1]?.order).toBe(2);
    expect(out.value[2]?.order).toBe(3);
    expect(logger.calls).toHaveLength(0);
  });

  it('reversed emission → reorders to dependency order, renumbers `order`, logs once', () => {
    // C blockedBy B, B blockedBy A, A — emitted C,B,A (reverse-topological).
    const logger = fakeLogger();
    const out = parseTaskList(
      [spec({ id: 'C', blockedBy: ['B'] }), spec({ id: 'B', blockedBy: ['A'] }), spec({ id: 'A' })],
      { project, mode: { kind: 'fixed', ticketId }, logger }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.map((t) => t.name)).toEqual(['task A', 'task B', 'task C']);
    expect(out.value[0]?.order).toBe(1);
    expect(out.value[1]?.order).toBe(2);
    expect(out.value[2]?.order).toBe(3);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.level).toBe('info');
    expect(logger.calls[0]?.message).toContain('reordered');
    expect(logger.calls[0]?.message).toContain('blockedBy');
  });

  it('cycle (A blockedBy B, B blockedBy A) → ParseError naming the cycle subset', () => {
    const out = parseTaskList([spec({ id: 'A', blockedBy: ['B'] }), spec({ id: 'B', blockedBy: ['A'] })], {
      project,
      mode: { kind: 'fixed', ticketId },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.name).toBe('ParseError');
    expect(out.error.subCode).toBe('schema-mismatch');
    expect(out.error.message).toContain('cycle');
    // Both task ids should appear in the unprocessed subset — minted UUIDs, but cycle text
    // surfaces the canonical ids the parser minted. Smoke-check both are represented.
    const idRe = /[0-9a-f-]{36}/g;
    const ids = out.error.message.match(idRe);
    expect(ids?.length).toBeGreaterThanOrEqual(2);
  });

  it('stable tiebreak — three independent tasks emitted A,B,C → output is A,B,C verbatim', () => {
    const logger = fakeLogger();
    const out = parseTaskList([spec({ id: 'A' }), spec({ id: 'B' }), spec({ id: 'C' })], {
      project,
      mode: { kind: 'fixed', ticketId },
      logger,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.map((t) => t.name)).toEqual(['task A', 'task B', 'task C']);
    expect(logger.calls).toHaveLength(0);
  });

  it('interleaved sound — A, B, C blockedBy A, D emitted A,B,C,D → verbatim no-op', () => {
    // ready=[A(0),B(1),D(3)] → emit A → C joins → ready=[B(1),C(2),D(3)] (sorted by
    // emission idx) → emit B → emit C → emit D. Result: A,B,C,D — identical to emission.
    const logger = fakeLogger();
    const out = parseTaskList(
      [spec({ id: 'A' }), spec({ id: 'B' }), spec({ id: 'C', blockedBy: ['A'] }), spec({ id: 'D' })],
      { project, mode: { kind: 'fixed', ticketId }, logger }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.map((t) => t.name)).toEqual(['task A', 'task B', 'task C', 'task D']);
    expect(out.value.map((t) => t.order)).toEqual([1, 2, 3, 4]);
    expect(logger.calls).toHaveLength(0);
  });

  it('interleaved unsound — D emitted before its blocker A → reorders to A,B,D,C', () => {
    // Input: B(0), D blockedBy A (1), A(2), C(3). After Kahn:
    // ready=[B(0),A(2),C(3)]; emit B → ready=[A(2),C(3)]; emit A → D joins → ready=[C(3),D(1)]
    //   (D inserted at sorted emission position 1). emit D(1) → emit C(3). Result: B,A,D,C.
    const logger = fakeLogger();
    const out = parseTaskList(
      [spec({ id: 'B' }), spec({ id: 'D', blockedBy: ['A'] }), spec({ id: 'A' }), spec({ id: 'C' })],
      { project, mode: { kind: 'fixed', ticketId }, logger }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.map((t) => t.name)).toEqual(['task B', 'task A', 'task D', 'task C']);
    expect(out.value.map((t) => t.order)).toEqual([1, 2, 3, 4]);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.message).toContain('reordered');
  });

  it('multi-root sound — two independent chains (A→B, X→Y) emitted A,X,B,Y → verbatim no-op', () => {
    // ready=[A,X]; emit A → B joins → ready=[X,B]; emit X → Y joins → ready=[B,Y]; emit B,Y.
    // Original emission was A,X,B,Y — Kahn's reproduces it exactly.
    const logger = fakeLogger();
    const out = parseTaskList(
      [spec({ id: 'A' }), spec({ id: 'X' }), spec({ id: 'B', blockedBy: ['A'] }), spec({ id: 'Y', blockedBy: ['X'] })],
      { project, mode: { kind: 'fixed', ticketId }, logger }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.map((t) => t.name)).toEqual(['task A', 'task X', 'task B', 'task Y']);
    expect(logger.calls).toHaveLength(0);
  });

  it('multi-root unsound — Y emitted before its blocker X → reorders, log fires', () => {
    const logger = fakeLogger();
    const out = parseTaskList(
      [spec({ id: 'A' }), spec({ id: 'Y', blockedBy: ['X'] }), spec({ id: 'B', blockedBy: ['A'] }), spec({ id: 'X' })],
      { project, mode: { kind: 'fixed', ticketId }, logger }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // ready=[A(0),X(3)]; emit A → B joins → ready=[B(2),X(3)]; emit B → ready=[X(3)];
    // emit X → Y joins → ready=[Y(1)]; emit Y. Result: A,B,X,Y (Y after X enforced).
    expect(out.value.map((t) => t.name)).toEqual(['task A', 'task B', 'task X', 'task Y']);
    expect(logger.calls).toHaveLength(1);
  });

  it('empty input → no-op, no log', () => {
    const logger = fakeLogger();
    const out = parseTaskList([], { project, mode: { kind: 'fixed', ticketId }, logger });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toHaveLength(0);
    expect(logger.calls).toHaveLength(0);
  });

  it('logger omitted on reorder → no throw, still reorders', () => {
    const out = parseTaskList([spec({ id: 'B', blockedBy: ['A'] }), spec({ id: 'A' })], {
      project,
      mode: { kind: 'fixed', ticketId },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.map((t) => t.name)).toEqual(['task A', 'task B']);
  });
});
