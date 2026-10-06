import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { FlowProgressStrip, fitStepStrip, stripText } from '@src/application/ui/tui/components/flow-progress-strip.tsx';
import type { FlowProgress, StepStatus, StepView } from '@src/application/ui/tui/runtime/flow-progress.ts';

const step = (label: string, status: StepStatus, extra: Partial<StepView> = {}): StepView => ({
  key: label,
  label,
  status,
  depth: 0,
  children: [],
  ...extra,
});

const progress = (spine: StepView[], extra: Partial<FlowProgress> = {}): FlowProgress => ({
  spine,
  activeSpineIndex: spine.findIndex((s) => s.status === 'running'),
  workItems: new Map(),
  hasTaskWorkItems: false,
  ...extra,
});

const spine = [
  step('Prepare', 'completed'),
  step('Run tasks', 'running', { progress: { done: 1, total: 5 } }),
  step('Finish', 'pending'),
];

describe('fitStepStrip', () => {
  it('fits full labels with a right-aligned position at 96 columns', () => {
    const strip = fitStepStrip(progress(spine), 96);
    const text = stripText(strip);
    expect(strip.level).toBe(1);
    expect(text).toHaveLength(96);
    expect(text.startsWith('steps  ■ Prepare  →  ◆ Run tasks 1/5  →  ◇ Finish')).toBe(true);
    expect(text.endsWith('step 2/3')).toBe(true);
  });

  it('goes glyph-only for inactive steps at 60 columns', () => {
    const strip = fitStepStrip(progress(spine), 50);
    const text = stripText(strip);
    expect(strip.level).toBe(2);
    expect(text).toContain('steps  ■  →  ◆ Run tasks 1/5  →  ◇');
    expect(text.length).toBeLessThanOrEqual(50);
  });

  it('shows the active step alone at 40 columns', () => {
    const strip = fitStepStrip(progress(spine), 40);
    expect(strip.level).toBe(3);
    expect(stripText(strip)).toBe('steps  ◆ Run tasks 1/5 · 2/3');
  });

  it('names the failure on the right when a step failed', () => {
    const failed = [step('Prepare', 'completed'), step('Run tasks', 'failed'), step('Finish', 'skipped')];
    const text = stripText(
      fitStepStrip(
        progress(failed, { activeSpineIndex: 1, failure: { label: 'Commit', workItemLabel: 'Add flag' } }),
        96
      )
    );
    expect(text).toContain('✗ Run tasks');
    expect(text.endsWith('failed at Commit · Add flag')).toBe(true);
  });
});

describe('FlowProgressStrip', () => {
  it('renders exactly one line even when the text is wider than the budget', () => {
    const r = render(<FlowProgressStrip progress={progress(spine)} width={20} />);
    expect((r.lastFrame() ?? '').split('\n')).toHaveLength(1);
    r.unmount();
  });

  it('renders nothing without a plan', () => {
    const r = render(<FlowProgressStrip progress={undefined} width={96} />);
    expect(r.lastFrame()).toBe('');
    r.unmount();
  });
});
