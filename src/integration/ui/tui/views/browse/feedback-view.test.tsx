import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

const getProgressMock = vi.fn<(id?: string) => Promise<string>>();

vi.mock('@src/integration/persistence/progress.ts', () => ({
  getProgress: (id?: string) => getProgressMock(id),
}));

import { FeedbackView, extractFeedback } from './feedback-view.tsx';

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

describe('extractFeedback', () => {
  it('returns entries for each User feedback block', () => {
    const content = [
      '## 2026-04-17T10:00:00Z',
      '',
      'User feedback: please tighten the loading state',
      '',
      '---',
      '',
      '## 2026-04-17T11:00:00Z',
      '',
      'task-complete',
      '',
      '---',
      '',
      '## 2026-04-17T12:00:00Z',
      '',
      'User feedback: add a dark mode',
      '',
    ].join('\n');

    const entries = extractFeedback(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.preview).toBe('please tighten the loading state');
    expect(entries[1]?.preview).toBe('add a dark mode');
  });

  it('returns empty array for empty progress', () => {
    expect(extractFeedback('')).toEqual([]);
  });
});

describe('FeedbackView', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders empty state when no feedback entries found', async () => {
    getProgressMock.mockResolvedValue('## ts\n\nrandom note\n\n---\n');

    const { lastFrame } = render(<FeedbackView sprintId="s1" />);
    await flush();

    expect(lastFrame() ?? '').toContain('No feedback yet');
  });

  it('renders each feedback entry', async () => {
    getProgressMock.mockResolvedValue(
      ['## 2026-04-17T10:00:00Z', '', 'User feedback: fix the button colour', '', '---', ''].join('\n')
    );

    const { lastFrame } = render(<FeedbackView sprintId="s1" />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('FEEDBACK');
    expect(frame).toContain('fix the button colour');
  });
});
