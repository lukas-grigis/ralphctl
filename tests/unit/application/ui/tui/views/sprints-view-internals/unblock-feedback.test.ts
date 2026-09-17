import { describe, expect, it } from 'vitest';
import {
  formatUnblockFeedback,
  type UnblockFeedbackInput,
} from '@src/application/ui/tui/views/sprints-view-internals/unblock-feedback.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

const SPRINT_ID = 'sprint-closed-fixture' as unknown as SprintId;

const base: UnblockFeedbackInput = {
  succeeded: 2,
  total: 2,
  lastError: undefined,
  sprintName: 'Closed Sprint',
  sprintId: SPRINT_ID,
  reopenRefused: 0,
  reopenReason: undefined,
  reopenHint: undefined,
  reopened: undefined,
};

describe('formatUnblockFeedback', () => {
  it('stays a plain success line when no sprint reopened', () => {
    expect(formatUnblockFeedback(base)).toBe('✓ unblocked 2 tasks in "Closed Sprint"');
  });

  it('names the reopen hop when the run carried the sprint to active', () => {
    expect(formatUnblockFeedback({ ...base, reopened: { from: 'done', to: 'active' } })).toBe(
      '✓ unblocked 2 tasks in "Closed Sprint" — sprint reopened done → active'
    );
  });

  // The second hop failed to persist, so implement still can't run the revived work — the head
  // glyph must downgrade to the warning, not read as a plain success tick.
  it('leads with the warning glyph when the sprint only got as far as review', () => {
    expect(formatUnblockFeedback({ ...base, reopened: { from: 'done', to: 'review' } })).toBe(
      '⚠ unblocked 2 tasks in "Closed Sprint" — sprint reopened done → review, not active'
    );
  });

  // A retried review → active hop that failed again reports from === to: nothing moved.
  it('says the sprint is still review when a retried reopen moved nothing', () => {
    expect(formatUnblockFeedback({ ...base, reopened: { from: 'review', to: 'review' } })).toBe(
      '⚠ unblocked 2 tasks in "Closed Sprint" — sprint still review'
    );
  });

  // Mirrors sprint-detail's `unblockedToast` — hint AND the retry steps that actually work on
  // this list (reopen, then `r` to reload, then `u` again), not just the refusal's bare message.
  it('keeps the stayed-closed clause when the reopen was refused, with the hint and retry steps', () => {
    expect(
      formatUnblockFeedback({
        ...base,
        reopenRefused: 2,
        reopenReason: "cannot reopen sprint 'closed'",
        reopenHint: "close sprint 'live-sprint' first",
      })
    ).toBe(
      `⚠ unblocked 2 tasks in "Closed Sprint" — sprint stayed closed: cannot reopen sprint 'closed' — close sprint 'live-sprint' first — then 'ralphctl sprint reopen sprint-closed-fixture', then r to reload, then u again`
    );
  });

  it('drops the hint clause when the conflict carries none, keeping the retry steps', () => {
    expect(formatUnblockFeedback({ ...base, reopenRefused: 1, reopenReason: 'cannot reopen' })).toBe(
      `⚠ unblocked 2 tasks in "Closed Sprint" — sprint stayed closed: cannot reopen — then 'ralphctl sprint reopen sprint-closed-fixture', then r to reload, then u again`
    );
  });
});
