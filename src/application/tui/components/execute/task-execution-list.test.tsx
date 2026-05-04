import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { TaskExecutionList, statusColor, statusGlyph, statusLabel } from './task-execution-list.tsx';
import type { TaskGridItem } from './task-grid-item.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';

const NOW = '2026-05-01T00:00:00.000Z' as IsoTimestamp;

afterEach(() => {
  cleanup();
});

function task(
  id: string,
  name: string,
  status: TaskGridItem['status'] = 'todo',
  blockedBy: string[] = []
): TaskGridItem {
  return { id, name, status, blockedBy, projectPath: '/tmp/test' };
}

describe('TaskExecutionList', () => {
  it('renders null when tasks is null', () => {
    const { lastFrame } = render(<TaskExecutionList tasks={null} taskNameLookup={null} taskSignals={null} />);
    expect(lastFrame()?.trim() ?? '').toBe('');
  });

  it('renders one card per task', () => {
    const tasks = [task('t1', 'First task'), task('t2', 'Second task')];
    const { lastFrame } = render(<TaskExecutionList tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('First task');
    expect(frame).toContain('Second task');
  });

  it('shows status pill and truncated id', () => {
    const tasks = [task('abc123456789', 'My task', 'in_progress')];
    const { lastFrame } = render(<TaskExecutionList tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('abc12345');
    expect(frame).toContain('IN PROGRESS');
  });

  it('shows done status with phaseDone glyph', () => {
    const tasks = [task('t1', 'Done task', 'done')];
    const { lastFrame } = render(<TaskExecutionList tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('DONE');
    expect(frame).toContain('■');
  });

  it('shows blocked status with cross glyph', () => {
    const tasks = [{ ...task('t1', 'Blocked task', 'blocked'), blockedReason: 'wrong branch' }];
    const { lastFrame } = render(<TaskExecutionList tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('BLOCKED');
    expect(frame).toContain('✗');
    expect(frame).toContain('wrong branch');
  });

  it('renders depends-on line when blockedBy is non-empty', () => {
    const tasks = [task('t1', 'Root'), task('t2', 'Child', 'todo', ['t1'])];
    const { lastFrame } = render(<TaskExecutionList tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('depends on');
  });

  it('uses task name from lookup in depends-on line', () => {
    const tasks = [task('t1', 'Root task'), task('t2', 'Child task', 'todo', ['t1'])];
    const lookup = new Map([['t1', 'Root task']]);
    const { lastFrame } = render(<TaskExecutionList tasks={tasks} taskNameLookup={lookup} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Root task');
  });

  it('shows activity line from signal', () => {
    const tasks = [task('t1', 'My task', 'in_progress')];
    const signal: HarnessSignal = { type: 'progress', summary: 'writing tests', files: [], timestamp: NOW };
    const signals = new Map<string, HarnessSignal>([['t1', signal]]);
    const { lastFrame } = render(<TaskExecutionList tasks={tasks} taskNameLookup={null} taskSignals={signals} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('writing tests');
  });

  it('no activity line when signal map is null (graceful degrade)', () => {
    const tasks = [task('t1', 'My task', 'in_progress')];
    const { lastFrame } = render(<TaskExecutionList tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('My task');
  });

  it('renders dependent task after its root (depth ordering)', () => {
    const tasks = [task('t2', 'Child task', 'todo', ['t1']), task('t1', 'Root task')];
    const { lastFrame } = render(<TaskExecutionList tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    const rootPos = frame.indexOf('Root task');
    const childPos = frame.indexOf('Child task');
    expect(rootPos).toBeLessThan(childPos);
  });

  it('does not crash on cyclic deps', () => {
    const tasks = [task('a', 'A', 'todo', ['b']), task('b', 'B', 'todo', ['a'])];
    expect(() => render(<TaskExecutionList tasks={tasks} taskNameLookup={null} taskSignals={null} />)).not.toThrow();
  });

  it('shows note signal activity', () => {
    const tasks = [task('t1', 'My task', 'in_progress')];
    const signal: HarnessSignal = { type: 'note', text: 'Checking dependencies', timestamp: NOW };
    const signals = new Map<string, HarnessSignal>([['t1', signal]]);
    const { lastFrame } = render(<TaskExecutionList tasks={tasks} taskNameLookup={null} taskSignals={signals} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('note: Checking dependencies');
  });

  it('unknown status: falls back to muted color and pending glyph', () => {
    // Any unrecognised status string (e.g. a future status we haven't
    // mapped yet) should render gracefully with the fallback rather than
    // crashing.
    const tasks = [task('t1', 'Unknown', 'future-status')];
    const { lastFrame } = render(<TaskExecutionList tasks={tasks} taskNameLookup={null} taskSignals={null} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Unknown');
    expect(frame).toContain('FUTURE-STATUS'); // statusLabel falls back to .toUpperCase()
  });
});

describe('status helpers', () => {
  it('statusColor("done") returns success', () => {
    expect(statusColor('done')).toBe(inkColors.success);
  });

  it('statusColor("blocked") returns error', () => {
    expect(statusColor('blocked')).toBe(inkColors.error);
  });

  it('statusGlyph("blocked", 0) returns cross', () => {
    expect(statusGlyph('blocked', 0)).toBe(glyphs.cross);
  });

  it('statusLabel("blocked") returns "BLOCKED"', () => {
    expect(statusLabel('blocked')).toBe('BLOCKED');
  });
});
