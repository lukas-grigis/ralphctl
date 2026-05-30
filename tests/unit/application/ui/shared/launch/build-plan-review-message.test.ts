/**
 * T3 — plan-gate human-facing note (audit §5). The parser dependency-resolves the task list
 * before it reaches the approval gate, so the order shown is the execution order; the gate must
 * SURFACE that reorder to the operator rather than hiding it as a silent topo-sort.
 */

import { describe, expect, it } from 'vitest';
import { buildPlanReviewMessage } from '@src/application/ui/shared/launch/plan.ts';

describe('buildPlanReviewMessage', () => {
  it('renders the dependency-resolved-execution-order note', () => {
    const message = buildPlanReviewMessage([{ name: 'do a thing' }]);
    expect(message).toContain('Tasks are shown in dependency-resolved execution order.');
  });

  it('still lists the task count and a numbered summary', () => {
    const message = buildPlanReviewMessage([
      { name: 'first', ticketRef: '#1' },
      { name: 'second', description: 'with detail' },
    ]);
    expect(message).toContain('Approve plan? 2 task(s):');
    expect(message).toContain('1. first  [#1]');
    expect(message).toContain('2. second');
    expect(message).toContain('   with detail');
    // The note precedes the per-task summary so the operator reads it before scanning the list.
    const noteIdx = message.indexOf('dependency-resolved execution order');
    const firstTaskIdx = message.indexOf('1. first');
    expect(noteIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeLessThan(firstTaskIdx);
  });
});
