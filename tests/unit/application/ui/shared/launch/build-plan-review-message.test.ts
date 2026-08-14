/**
 * T3 — plan-gate human-facing note (audit §5). The parser dependency-resolves the task list
 * before it reaches the approval gate, so the order shown is the execution order; the gate must
 * SURFACE that reorder to the operator rather than hiding it as a silent topo-sort.
 *
 * Feature A adds the deterministic plan critic's findings above that body — advisory evidence the
 * operator reads before deciding, never a gate that decides for them.
 */

import { describe, expect, it } from 'vitest';
import { buildPlanReviewMessage } from '@src/application/ui/shared/launch/plan.ts';
import type { PlanCheckFinding } from '@src/business/sprint/check-plan.ts';

const errorFinding = (detail: string): PlanCheckFinding => ({ kind: 'task-graph', detail });

const warningFinding = (criterionId: string): PlanCheckFinding => ({
  kind: 'prose-command',
  detail: 'command reads as prose',
  taskOrder: 1,
  taskName: 'do a thing',
  criterionId,
  command: 'Run the tests.',
});

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

  it('is byte-identical with an empty findings list and with the argument omitted', () => {
    const tasks = [{ name: 'first', ticketRef: '#1' }, { name: 'second' }];
    expect(buildPlanReviewMessage(tasks, [])).toBe(buildPlanReviewMessage(tasks));
    expect(buildPlanReviewMessage(tasks)).toMatch(/^Approve plan\? 2 task\(s\):/);
  });

  it('prepends findings above the body, errors before warnings', () => {
    const message = buildPlanReviewMessage(
      [{ name: 'do a thing' }],
      [warningFinding('C1'), errorFinding('task A depends on itself')]
    );
    expect(message).toMatch(/^Plan check found 2 issue\(s\) — advisory, you decide:/);
    const errorIdx = message.indexOf('depends on itself');
    const warningIdx = message.indexOf('reads as prose');
    const bodyIdx = message.indexOf('Approve plan?');
    expect(errorIdx).toBeLessThan(warningIdx);
    expect(warningIdx).toBeLessThan(bodyIdx);
  });

  it('caps the rendered findings at 10 and tails the remainder', () => {
    const findings = Array.from({ length: 14 }, (_, i) => warningFinding(`C${String(i + 1)}`));
    const message = buildPlanReviewMessage([{ name: 'do a thing' }], findings);

    expect(message).toContain('Plan check found 14 issue(s)');
    expect(message).toContain('… and 4 more');
    expect(message).toContain('[C10]');
    expect(message).not.toContain('[C11]');
    // The task body survives the cap — that is the point of capping.
    expect(message).toContain('Approve plan? 1 task(s):');
  });
});
