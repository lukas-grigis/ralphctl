/** FlowStepsTree rendering at the 100-column test width: grouping, inline rounds, failure rows, windowing. */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { FlowStepsTree } from '@src/application/ui/tui/components/flow-steps-tree.tsx';
import type { StepStatus, StepView } from '@src/application/ui/tui/runtime/flow-progress.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

const leaf = (label: string, status: StepStatus, extra: Partial<StepView> = {}): StepView => ({
  key: label,
  label,
  status,
  depth: 0,
  children: [],
  ...extra,
});

const frameOf = (
  spine: readonly StepView[],
  opts: { running?: boolean; settled?: boolean; maxRows?: number } = {}
): string => {
  const r = render(
    <FlowStepsTree
      spine={spine}
      maxRows={opts.maxRows ?? 20}
      running={opts.running ?? true}
      settled={opts.settled ?? false}
    />
  );
  const out = r.lastFrame() ?? '';
  r.unmount();
  return out;
};

const SPINNER = new Set<string>(glyphs.spinner);
const hasSpinner = (frame: string): boolean => [...frame].some((c) => SPINNER.has(c));

describe('FlowStepsTree', () => {
  it('collapses a completed group to `N steps · duration`', () => {
    const frame = frameOf([
      { ...leaf('Prepare', 'completed', { durationMs: 1100 }), leafCount: 4 },
      leaf('Plan with AI', 'pending'),
    ]);
    expect(frame).toContain('■ Prepare · 4 steps · 1.1s');
    expect(frame).toContain('◇ Plan with AI');
  });

  it('expands the active path and indents children', () => {
    const frame = frameOf([
      {
        ...leaf('Run tasks', 'running', { progress: { done: 0, total: 1 } }),
        leafCount: 5,
        children: [leaf('Check branch', 'completed', { depth: 1, durationMs: 62 })],
      },
    ]);
    const lines = frame.split('\n');
    expect(lines.find((l) => l.includes('Run tasks 0/1'))).toMatch(/^ {2}◆ Run tasks 0\/1/);
    expect(lines.find((l) => l.includes('Check branch'))).toMatch(/^ {4}■ Check branch · 62ms/);
  });

  it('renders the running round inline with its leaves and finished rounds with a verdict chip', () => {
    const frame = frameOf([
      {
        ...leaf('Attempt', 'running', { iteration: { n: 1, max: 3 } }),
        leafCount: 6,
        children: [
          {
            ...leaf('Round', 'completed', {
              depth: 1,
              iteration: { n: 1 },
              durationMs: 270,
              verdict: { status: 'failed', dimensions: ['correctness'], headline: 'wrong output' },
            }),
            leafCount: 2,
          },
          {
            ...leaf('Round', 'running', {
              key: 'round2',
              depth: 1,
              iteration: { n: 2, max: 5 },
              inline: [leaf('Generate', 'running', { depth: 2 }), leaf('Evaluate', 'pending', { depth: 2 })],
            }),
            leafCount: 2,
          },
        ],
      },
    ]);
    expect(frame).toContain('◆ Attempt 1/3');
    expect(frame).toContain('■ Round 1 · 270ms · ✗ correctness — wrong output');
    expect(frame).toMatch(/◆ Round 2\/5 · \S Generate · ◇ Evaluate/);
    expect(hasSpinner(frame)).toBe(true);
  });

  it('renders a passed chip and a malformed chip with distinct shapes', () => {
    const frame = frameOf([
      leaf('Round', 'completed', {
        key: 'a',
        iteration: { n: 1 },
        leafCount: 1,
        verdict: { status: 'passed', dimensions: [] },
      }),
      leaf('Round', 'completed', {
        key: 'b',
        iteration: { n: 2 },
        leafCount: 1,
        verdict: { status: 'malformed', dimensions: [] },
      }),
    ]);
    expect(frame).toContain('✓ passed');
    expect(frame).toContain('? malformed');
  });

  it('puts a failed row message on its own row beneath it', () => {
    const frame = frameOf(
      [leaf('Commit', 'failed', { durationMs: 80, errorMessage: "git commit failed:\n  pathspec 'x' did not match" })],
      { running: false, settled: true }
    );
    const lines = frame.split('\n');
    const at = lines.findIndex((l) => l.includes('✗ Commit · 80ms'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at]).not.toContain('git commit failed');
    expect(lines[at + 1]).toMatch(/^ {4}— git commit failed: pathspec 'x' did not match/);
  });

  it('renders waiting as a warning glyph with no spinner', () => {
    const frame = frameOf([leaf('Approve plan', 'waiting')]);
    expect(frame).toContain('⚠ Approve plan · waiting on you');
    expect(hasSpinner(frame)).toBe(false);
  });

  it('marks a skipped main step and keeps pending labels', () => {
    const frame = frameOf([leaf('Finish', 'skipped')], { running: false, settled: true });
    expect(frame).toContain('◌ Finish · skipped');
  });

  it('windows long lists around the running row with overflow cues', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      leaf(`step-${String(i)}`, i < 14 ? 'completed' : i === 14 ? 'running' : 'pending')
    );
    const frame = frameOf(rows, { maxRows: 7 });
    expect(frame).toContain('step-14');
    expect(frame).toContain('▴');
    expect(frame).toContain('▾');
    expect(frame.split('\n').length).toBeLessThanOrEqual(7);
    expect(frame).not.toContain('step-0\n');
  });

  it('anchors on the failed row when the run settled failed', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      leaf(`step-${String(i)}`, i < 4 ? 'completed' : i === 4 ? 'failed' : 'skipped')
    );
    const frame = frameOf(rows, { maxRows: 6, running: false, settled: true });
    expect(frame).toContain('✗ step-4');
  });

  it('truncates a long label instead of wrapping', () => {
    const r = render(
      <FlowStepsTree spine={[leaf(`${'x'.repeat(90)}`, 'completed')]} running={false} settled maxRows={5} width={30} />
    );
    const lines = (r.lastFrame() ?? '').split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('…');
    r.unmount();
  });
});
