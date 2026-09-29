import { describe, expect, it } from 'vitest';
import { buildIdeateReviewMessage } from '@src/application/ui/shared/launch/ideate.ts';

describe('buildIdeateReviewMessage', () => {
  it('renders the requirements body before the task list', () => {
    const msg = buildIdeateReviewMessage('## Problem\nneeds export', [
      { name: 'Add button', steps: ['make it'], repository: 'web' },
    ]);
    expect(msg.indexOf('needs export')).toBeGreaterThan(-1);
    expect(msg.indexOf('needs export')).toBeLessThan(msg.indexOf('1. Add button'));
    expect(msg).toContain('steps:');
    expect(msg).toContain('repository: web');
  });
});
