import { describe, expect, it } from 'vitest';
import { buildIdeateReviewMessage } from '@src/application/ui/shared/launch/ideate.ts';

describe('buildIdeateReviewMessage', () => {
  const tasks = [{ name: 'Add button', steps: ['make it'], repository: 'web' }];

  it('puts the approve question in the header and requirements before the task list in the body', () => {
    const msg = buildIdeateReviewMessage('## Problem\nneeds export', tasks);
    const sep = msg.indexOf('\n\n');
    expect(msg.slice(0, sep)).toBe('Approve ideate? 1 task(s)');
    const body = msg.slice(sep + 2);
    expect(body.indexOf('needs export')).toBeGreaterThan(-1);
    expect(body.indexOf('needs export')).toBeLessThan(body.indexOf('1. Add button'));
    expect(msg).toContain('steps:');
    expect(msg).toContain('repository: web');
  });

  it('keeps critic findings and the question together in the header', () => {
    const msg = buildIdeateReviewMessage('req body', tasks, [{ kind: 'task-graph', detail: 'cycle' }]);
    const header = msg.slice(0, msg.indexOf('\n\n'));
    expect(header).toContain('Plan check found 1 issue(s)');
    expect(header.endsWith('Approve ideate? 1 task(s)')).toBe(true);
    expect(header).not.toContain('req body');
  });
});
