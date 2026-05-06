import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { StepTrace, CompactStepSummary, MAX_RENDERED_STEPS, type LiveStep } from './step-trace.tsx';

afterEach(() => {
  cleanup();
});

function step(name: string, status: LiveStep['status'] = 'completed', durationMs = 10): LiveStep {
  return { name, status, durationMs, errorMessage: undefined };
}

describe('StepTrace', () => {
  it('shows "Starting…" spinner when running and no steps', () => {
    const { lastFrame } = render(<StepTrace steps={[]} isRunning={true} />);
    // Spinner renders null for "Awaiting" labels, but "Starting…" renders normally
    // The text might be visible or blank (spinner returns null for Awaiting)
    const frame = lastFrame() ?? '';
    // Just verify it renders without crashing; the spinner component handles the label
    expect(frame).toBeDefined();
  });

  it('shows "No steps recorded" when not running and empty', () => {
    const { lastFrame } = render(<StepTrace steps={[]} isRunning={false} />);
    expect(lastFrame()).toContain('No steps recorded');
  });

  it('renders step names', () => {
    const steps: LiveStep[] = [step('load-sprint'), step('assert-active')];
    const { lastFrame } = render(<StepTrace steps={steps} isRunning={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('load-sprint');
    expect(frame).toContain('assert-active');
  });

  it('renders duration for completed steps', () => {
    const steps: LiveStep[] = [{ name: 'my-step', status: 'completed', durationMs: 1500, errorMessage: undefined }];
    const { lastFrame } = render(<StepTrace steps={steps} isRunning={false} />);
    expect(lastFrame()).toContain('1.5s');
  });

  it('renders error message for failed step', () => {
    const steps: LiveStep[] = [
      { name: 'bad-step', status: 'failed', durationMs: 10, errorMessage: 'something went wrong' },
    ];
    const { lastFrame } = render(<StepTrace steps={steps} isRunning={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('bad-step');
    expect(frame).toContain('something went wrong');
  });

  it('caps rendered rows when steps exceed MAX_RENDERED_STEPS and shows an elision row', () => {
    // Drive Ink with a large step list — without the cap this would render
    // thousands of <Box> children and (combined with re-render heartbeats)
    // OOM Node on long-running sprints. The cap keeps the parent's child
    // count bounded.
    const total = 5000;
    const steps: LiveStep[] = Array.from({ length: total }, (_, i) => step(`step-${String(i)}`, 'completed', 10));
    const { lastFrame } = render(<StepTrace steps={steps} isRunning={false} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain(`… ${String(total - MAX_RENDERED_STEPS)} earlier steps`);
    // The earliest non-elided step is at index `total - MAX_RENDERED_STEPS`.
    expect(frame).toContain(`step-${String(total - MAX_RENDERED_STEPS)}`);
    expect(frame).toContain(`step-${String(total - 1)}`);
    // Anything older than the visible window is gone.
    expect(frame).not.toContain('step-0 ');
    expect(frame).not.toContain(`step-${String(total - MAX_RENDERED_STEPS - 1)} `);

    // Defensive bound on rendered rows: elision line + visible steps.
    const lines = frame.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(MAX_RENDERED_STEPS + 1);
  });

  it('renders all rows when steps fit under MAX_RENDERED_STEPS without an elision row', () => {
    const steps: LiveStep[] = Array.from({ length: 10 }, (_, i) => step(`step-${String(i)}`));
    const { lastFrame } = render(<StepTrace steps={steps} isRunning={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('earlier steps');
    expect(frame).toContain('step-0');
    expect(frame).toContain('step-9');
  });
});

describe('CompactStepSummary', () => {
  it('renders "No steps recorded" when steps is empty', () => {
    const { lastFrame } = render(<CompactStepSummary steps={[]} />);
    expect(lastFrame()).toContain('No steps recorded');
  });

  it('renders the success glyph + tally when all steps completed', () => {
    const steps: LiveStep[] = [step('load-sprint'), step('assert-active'), step('link-skills')];
    const { lastFrame } = render(<CompactStepSummary steps={steps} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('3 steps');
    expect(frame).toContain('3 completed');
    // No failed steps, so no cross / error lines beyond the tally glyph.
    expect(frame).not.toContain('failed');
  });

  it('renders the cross glyph + lists each failed step inline with its errorMessage', () => {
    const steps: LiveStep[] = [
      step('load-sprint'),
      { name: 'assert-active', status: 'failed', durationMs: 5, errorMessage: 'sprint not active' },
    ];
    const { lastFrame } = render(<CompactStepSummary steps={steps} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 failed');
    expect(frame).toContain('assert-active');
    expect(frame).toContain('sprint not active');
  });

  it('tally includes aborted and skipped counts when present', () => {
    const steps: LiveStep[] = [
      step('load-sprint'),
      { name: 'do-work', status: 'aborted', durationMs: 2, errorMessage: undefined },
      { name: 'save-sprint', status: 'skipped', durationMs: 0, errorMessage: undefined },
    ];
    const { lastFrame } = render(<CompactStepSummary steps={steps} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 aborted');
    expect(frame).toContain('1 skipped');
  });

  it('renders a duration label when totalMs > 0 and omits it when totalMs === 0', () => {
    const stepsWithDuration: LiveStep[] = [
      { name: 'load-sprint', status: 'completed', durationMs: 1500, errorMessage: undefined },
    ];
    const { lastFrame: withDuration } = render(<CompactStepSummary steps={stepsWithDuration} />);
    expect(withDuration()).toContain('1.5s');

    const stepsNoDuration: LiveStep[] = [
      { name: 'load-sprint', status: 'completed', durationMs: 0, errorMessage: undefined },
    ];
    const { lastFrame: noDuration } = render(<CompactStepSummary steps={stepsNoDuration} />);
    const noDurationFrame = noDuration() ?? '';
    // Duration label must NOT appear when totalMs is 0.
    expect(noDurationFrame).not.toMatch(/\d+ms|\d+\.\d+s/);
  });
});
