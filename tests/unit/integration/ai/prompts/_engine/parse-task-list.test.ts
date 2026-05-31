import { describe, expect, it, vi } from 'vitest';
import { parseTaskList } from '@src/integration/ai/prompts/_engine/parse-task-list.ts';
import type { TodoTask } from '@src/domain/entity/task.ts';
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

/**
 * Map each task's index → the original spec `id` it was minted from. The parser strips the
 * user-supplied id and mints a UUID, but `name` is `task <id>`, so the trailing token recovers
 * the spec id deterministically for graph-shape assertions.
 */
const specIdOf = (t: TodoTask): string => t.name.replace(/^task /, '');

/**
 * Assert the result is a valid topological order of the supplied `blockedBy` edges: every
 * dependency appears strictly before its dependent. Edges are keyed by spec id (the recoverable
 * label), not the minted UUID. Also asserts the renumbered `order` field is monotonic with
 * respect to dependencies — a dependency's `order` is always strictly less than its dependent's.
 */
const assertTopologicallyValid = (
  tasks: readonly TodoTask[],
  edges: Readonly<Record<string, readonly string[]>>
): void => {
  const positionById = new Map<string, number>();
  const orderById = new Map<string, number>();
  tasks.forEach((t, i) => {
    positionById.set(specIdOf(t), i);
    orderById.set(specIdOf(t), t.order);
  });

  for (const [dependent, deps] of Object.entries(edges)) {
    const depPos = positionById.get(dependent);
    expect(depPos, `dependent ${dependent} present`).not.toBeUndefined();
    for (const dep of deps) {
      const blockerPos = positionById.get(dep);
      expect(blockerPos, `blocker ${dep} present`).not.toBeUndefined();
      // Topological validity: blocker precedes dependent in the flattened sequence.
      expect(blockerPos!).toBeLessThan(depPos!);
      // Monotonic `order`: a dependency's renumbered order is strictly less than its dependent's.
      expect(orderById.get(dep)!).toBeLessThan(orderById.get(dependent)!);
    }
  }
};

/** `order` is renumbered to the 1-based array position — dense, gap-free, ascending. */
const assertOrderMatchesPosition = (tasks: readonly TodoTask[]): void => {
  expect(tasks.map((t) => t.order)).toEqual(tasks.map((_t, i) => i + 1));
};

describe('parseTaskList — dependency-wave schedule', () => {
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
    expect(out.value.map(specIdOf)).toEqual(['A', 'B', 'C']);
    assertOrderMatchesPosition(out.value);
    // Linear chain already in order → strict no-op, no log line.
    expect(logger.calls).toHaveLength(0);
  });

  it('reversed emission → reorders to a valid topological order, renumbers `order`, logs once', () => {
    // C blockedBy B, B blockedBy A, A — emitted C,B,A (reverse-topological).
    const logger = fakeLogger();
    const out = parseTaskList(
      [spec({ id: 'C', blockedBy: ['B'] }), spec({ id: 'B', blockedBy: ['A'] }), spec({ id: 'A' })],
      { project, mode: { kind: 'fixed', ticketId }, logger }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    assertTopologicallyValid(out.value, { B: ['A'], C: ['B'] });
    assertOrderMatchesPosition(out.value);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.level).toBe('info');
    expect(logger.calls[0]?.message).toContain('reordered');
    expect(logger.calls[0]?.message).toContain('blockedBy');
  });

  it('cycle (A blockedBy B, B blockedBy A) → ParseError via the shared graph path', () => {
    const out = parseTaskList([spec({ id: 'A', blockedBy: ['B'] }), spec({ id: 'B', blockedBy: ['A'] })], {
      project,
      mode: { kind: 'fixed', ticketId },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.name).toBe('ParseError');
    expect(out.error.subCode).toBe('schema-mismatch');
    // `renderTaskGraphIssue` phrases a cycle as `dependency cycle: <id> → <id> → ...`.
    expect(out.error.message).toContain('cycle');
    // The cycle text surfaces the minted UUIDs of the participating tasks; both appear.
    const idRe = /[0-9a-f-]{36}/g;
    const ids = out.error.message.match(idRe);
    expect(ids?.length).toBeGreaterThanOrEqual(2);
  });

  it('three independent tasks → all present, monotonic order, no log', () => {
    const logger = fakeLogger();
    const out = parseTaskList([spec({ id: 'A' }), spec({ id: 'B' }), spec({ id: 'C' })], {
      project,
      mode: { kind: 'fixed', ticketId },
      logger,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.map(specIdOf).sort()).toEqual(['A', 'B', 'C']);
    assertOrderMatchesPosition(out.value);
    // No edges → no constraint violated; an already-ordered independent set is a no-op.
    expect(logger.calls).toHaveLength(0);
  });

  it('diamond — D blockedBy B,C; B,C blockedBy A → A first, D last, monotonic order', () => {
    // A → {B, C} → D. The exact within-wave position of B vs C is unspecified by topology;
    // we assert only that every edge is honoured (Kahn-by-level diverges from a global ready
    // queue, so sequence identity would be the WRONG assertion).
    const out = parseTaskList(
      [
        spec({ id: 'A' }),
        spec({ id: 'B', blockedBy: ['A'] }),
        spec({ id: 'C', blockedBy: ['A'] }),
        spec({ id: 'D', blockedBy: ['B', 'C'] }),
      ],
      { project, mode: { kind: 'fixed', ticketId } }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    assertTopologicallyValid(out.value, { B: ['A'], C: ['A'], D: ['B', 'C'] });
    assertOrderMatchesPosition(out.value);
    expect(out.value[0] !== undefined && specIdOf(out.value[0])).toBe('A');
    expect(out.value[3] !== undefined && specIdOf(out.value[3])).toBe('D');
  });

  it('interleaved unsound — D emitted before its blocker A → valid topological order, log fires', () => {
    // Input emits D before A, so the schedule MUST reorder. Assert validity, not the exact
    // by-level sequence (which differs from the old global-ready-queue order).
    const logger = fakeLogger();
    const out = parseTaskList(
      [spec({ id: 'B' }), spec({ id: 'D', blockedBy: ['A'] }), spec({ id: 'A' }), spec({ id: 'C' })],
      { project, mode: { kind: 'fixed', ticketId }, logger }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    assertTopologicallyValid(out.value, { D: ['A'] });
    assertOrderMatchesPosition(out.value);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.message).toContain('reordered');
  });

  it('multi-root — two independent chains (A→B, X→Y) → both edges honoured, monotonic order', () => {
    const out = parseTaskList(
      [spec({ id: 'A' }), spec({ id: 'X' }), spec({ id: 'B', blockedBy: ['A'] }), spec({ id: 'Y', blockedBy: ['X'] })],
      { project, mode: { kind: 'fixed', ticketId } }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    assertTopologicallyValid(out.value, { B: ['A'], Y: ['X'] });
    assertOrderMatchesPosition(out.value);
  });

  it('multi-root unsound — Y emitted before its blocker X → reorders to a valid order, log fires', () => {
    const logger = fakeLogger();
    const out = parseTaskList(
      [spec({ id: 'A' }), spec({ id: 'Y', blockedBy: ['X'] }), spec({ id: 'B', blockedBy: ['A'] }), spec({ id: 'X' })],
      { project, mode: { kind: 'fixed', ticketId }, logger }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    assertTopologicallyValid(out.value, { B: ['A'], Y: ['X'] });
    assertOrderMatchesPosition(out.value);
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

  it('logger omitted on reorder → no throw, still produces a valid topological order', () => {
    const out = parseTaskList([spec({ id: 'B', blockedBy: ['A'] }), spec({ id: 'A' })], {
      project,
      mode: { kind: 'fixed', ticketId },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    assertTopologicallyValid(out.value, { B: ['A'] });
    assertOrderMatchesPosition(out.value);
  });
});
