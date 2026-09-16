import { describe, expect, it } from 'vitest';
import {
  formatUnblockFeedback,
  type UnblockFeedbackInput,
} from '@src/application/ui/tui/views/sprints-view-internals/unblock-feedback.ts';

const base: UnblockFeedbackInput = {
  succeeded: 2,
  total: 2,
  lastError: undefined,
  sprintName: 'Closed Sprint',
  reopenRefused: 0,
  reopenReason: undefined,
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

  // The second hop failed to persist, so implement still can't run the revived work.
  it('says so when the sprint only got as far as review', () => {
    expect(formatUnblockFeedback({ ...base, reopened: { from: 'done', to: 'review' } })).toBe(
      '✓ unblocked 2 tasks in "Closed Sprint" — sprint reopened done → review, not active'
    );
  });

  it('keeps the stayed-closed clause when the reopen was refused', () => {
    expect(formatUnblockFeedback({ ...base, reopenRefused: 2, reopenReason: "cannot reopen sprint 'closed'" })).toBe(
      `✓ unblocked 2 tasks in "Closed Sprint" — sprint stayed closed: cannot reopen sprint 'closed'`
    );
  });
});
