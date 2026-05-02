/**
 * SprintSummaryLine component tests.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SprintSummaryLine, type SprintSummaryData } from './sprint-summary-line.tsx';

function makeData(overrides: Partial<SprintSummaryData> = {}): SprintSummaryData {
  return {
    name: 'Alpha Sprint',
    status: 'draft',
    ticketCount: 3,
    taskCount: 5,
    tasksDone: 2,
    branch: null,
    ...overrides,
  };
}

describe('SprintSummaryLine', () => {
  it('renders null data as "No current sprint set"', () => {
    const { lastFrame } = render(<SprintSummaryLine data={null} />);
    expect(lastFrame()).toContain('No current sprint set');
  });

  it('renders sprint name', () => {
    const { lastFrame } = render(<SprintSummaryLine data={makeData()} />);
    expect(lastFrame()).toContain('Alpha Sprint');
  });

  it('renders sprint status chip', () => {
    const { lastFrame } = render(<SprintSummaryLine data={makeData({ status: 'active' })} />);
    expect(lastFrame()).toContain('ACTIVE');
  });

  it('renders ticket count', () => {
    const { lastFrame } = render(<SprintSummaryLine data={makeData({ ticketCount: 4 })} />);
    expect(lastFrame()).toContain('4 tickets');
  });

  it('renders task count with done count', () => {
    const { lastFrame } = render(<SprintSummaryLine data={makeData({ taskCount: 7, tasksDone: 3 })} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('7 tasks');
    expect(frame).toContain('3 done');
  });

  it('renders branch name when branch is set', () => {
    const { lastFrame } = render(<SprintSummaryLine data={makeData({ branch: 'ralphctl/sprint-1' })} />);
    expect(lastFrame()).toContain('branch ralphctl/sprint-1');
  });

  it('does not render branch when branch is null', () => {
    const { lastFrame } = render(<SprintSummaryLine data={makeData({ branch: null })} />);
    expect(lastFrame()).not.toContain('branch');
  });

  it('does not render branch when branch is empty string', () => {
    const { lastFrame } = render(<SprintSummaryLine data={makeData({ branch: '' })} />);
    expect(lastFrame()).not.toContain('branch');
  });

  it('uses singular "ticket" for count of 1', () => {
    const { lastFrame } = render(<SprintSummaryLine data={makeData({ ticketCount: 1 })} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 ticket');
    expect(frame).not.toContain('1 tickets');
  });

  it('uses singular "task" for count of 1', () => {
    const { lastFrame } = render(<SprintSummaryLine data={makeData({ taskCount: 1, tasksDone: 0 })} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 task');
    expect(frame).not.toContain('1 tasks');
  });

  it('renders CLOSED status chip for closed sprint', () => {
    const { lastFrame } = render(<SprintSummaryLine data={makeData({ status: 'closed' })} />);
    expect(lastFrame()).toContain('CLOSED');
  });
});
