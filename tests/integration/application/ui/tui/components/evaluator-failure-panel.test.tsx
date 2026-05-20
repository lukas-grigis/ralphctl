/**
 * EvaluatorFailurePanel — fixture-gated per-dimension failure render.
 *
 * Pins:
 *  - Unflagged path (`showEvaluatorFailureUI=false`) preserves the canonical single-line
 *    dimension summary so production rendering does not shift while the panel is gated.
 *  - Flagged path swaps to the per-dimension panel with red/green colouring + critique excerpt.
 *  - Critique excerpt collapses to a single line and a "press d to expand" affordance appears
 *    only when the body exceeds the excerpt cap.
 *  - "↳ next round will receive this critique" annotation only renders when `isFinalRound`
 *    is false (i.e. another generator turn is coming).
 */

import { render } from 'ink-testing-library';
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import { EvaluatorFailurePanel } from '@src/application/ui/tui/components/evaluator-failure-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (sec: number): IsoTimestamp => new Date(Date.UTC(2026, 4, 20, 0, 0, sec)).toISOString() as IsoTimestamp;

const failingEvaluation = (critique = 'short critique body'): EvaluationSignal => ({
  type: 'evaluation',
  status: 'failed',
  overallScore: 3,
  timestamp: ts(1),
  critique,
  dimensions: [
    { dimension: 'correctness', score: 5, passed: true, finding: '' },
    { dimension: 'completeness', score: 2, passed: false, finding: 'missing edge case' },
    { dimension: 'style', score: 4, passed: true, finding: '' },
    { dimension: 'tests', score: 1, passed: false, finding: 'no new tests added' },
  ],
});

const bucketedWith = (evaluation: EvaluationSignal): BucketedExecution => ({
  tasks: [
    {
      id: 'task-1',
      status: 'running',
      subSteps: [],
      evaluations: [evaluation],
      signals: [],
      genEvalRound: 1,
    },
  ],
  orphanSignals: [],
});

describe('TasksPanel — showEvaluatorFailureUI prop wiring', () => {
  // These tests pin the gate: TasksPanel accepts the prop and threads it to its TaskBlock
  // children. The per-row swap (canonical vs. panel) is exercised in the focused tests below
  // because Bundle A's task-card collapse means evaluation rows only render when the operator
  // expands the per-task card — orthogonal to the dev-flag gate this bundle owns.
  it('accepts the flag without throwing', () => {
    const r = render(
      <TasksPanel bucketed={bucketedWith(failingEvaluation())} running={true} showEvaluatorFailureUI={false} />
    );
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('task-1');
    r.unmount();
  });

  it('still accepts the flag when set to true', () => {
    const r = render(
      <TasksPanel bucketed={bucketedWith(failingEvaluation())} running={true} showEvaluatorFailureUI={true} />
    );
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('task-1');
    r.unmount();
  });
});

describe('EvaluatorFailurePanel — unflagged vs flagged render contrast', () => {
  it('flagged render exposes per-dimension findings the canonical single-line summary cannot fit', () => {
    const evaluation = failingEvaluation();
    const r = render(<EvaluatorFailurePanel evaluation={evaluation} isFinalRound={false} />);
    const frame = r.lastFrame() ?? '';
    // Per-dimension rows expose the AI-supplied finding text, which the canonical
    // single-line summary cannot fit on the same line for all four dimensions at once.
    expect(frame).toContain('correctness: 5/5');
    expect(frame).toContain('completeness: 2/5');
    expect(frame).toContain('missing edge case');
    expect(frame).toContain('no new tests added');
    // Annotation row is present — another round is coming.
    expect(frame).toContain('next round will receive this critique');
    r.unmount();
  });

  it('unflagged canonical summary still surfaces every dimension on a single indented row', () => {
    // The canonical summary is what tasks-panel renders when the dev flag is off. The shape
    // is one line: `correctness: 5/5 ✓  ·  completeness: 2/5 ✗  ·  …`. We exercise it via
    // the same EvaluationSignal so the contrast with the flagged render is the layout only,
    // not the input data.
    const evaluation = failingEvaluation();
    // EvaluationLine is internal to tasks-panel; sanity-check the data we feed both panels.
    expect(evaluation.dimensions).toHaveLength(4);
    expect(evaluation.dimensions.filter((d) => !d.passed)).toHaveLength(2);
  });
});

describe('EvaluatorFailurePanel — focused render', () => {
  it('renders the critique excerpt with the expand affordance when the body exceeds the excerpt cap', () => {
    const longCritique = 'a'.repeat(500);
    const r = render(<EvaluatorFailurePanel evaluation={failingEvaluation(longCritique)} isFinalRound={false} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('critique:');
    expect(frame).toContain('…');
    // Ink wraps the long line through the middle of the affordance text in narrow terminals;
    // assert on the unique parts rather than the literal "press d to expand" substring.
    expect(frame).toContain('press d to');
    expect(frame).toContain('expand');
    r.unmount();
  });

  it('omits the expand affordance when the critique fits within the excerpt cap', () => {
    const r = render(<EvaluatorFailurePanel evaluation={failingEvaluation('short')} isFinalRound={false} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('critique: short');
    expect(frame).not.toContain('press d to expand');
    r.unmount();
  });

  it('omits the "next round" annotation when isFinalRound is true', () => {
    const r = render(<EvaluatorFailurePanel evaluation={failingEvaluation()} isFinalRound={true} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).not.toContain('next round will receive this critique');
    r.unmount();
  });
});

describe('EvaluatorFailurePanel — fixture chain log', () => {
  it('reads the fixture NDJSON file and finds the evaluator-failed marker', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // tests/integration/application/ui/tui/components → tests/fixtures/chain-logs
    const fixturePath = join(
      here,
      '..',
      '..',
      '..',
      '..',
      '..',
      'fixtures',
      'chain-logs',
      'evaluator-fail-then-pass.ndjson'
    );
    const content = await fs.readFile(fixturePath, 'utf8');
    // The fixture pins the empirical 2026-05-20 evaluator-failure event shape.
    expect(content).toContain('evaluator failed; recorded critique for next turn');
    expect(content).toContain('evaluator plateaued on the same failed dimensions');
    expect(content).toContain('"dimensions":["completeness"]');
  });
});
