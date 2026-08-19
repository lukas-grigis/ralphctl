/**
 * EvaluatorFailurePanel — per-dimension verdict render, fed by the parsed `evaluation.md`.
 *
 * Pins:
 *  - Every dimension in the file surfaces with its own verdict word and finding prose.
 *  - An `n/a` dimension renders as NEITHER a pass nor a fail. This is a regression fence: the
 *    panel used to key presentation off `dimension.passed`, and the renderer emits `n/a` for a
 *    not-applicable dimension whose source signal carries `passed: false` — so every N/A dimension
 *    was reported to the operator as a red failure.
 *  - The critique renders in FULL with no excerpt / expand affordance, and the panel registers no
 *    keyboard handler (the old bare `d` double-fired with StatusBanner's ungated dismiss).
 *  - The Tasks panel card keeps its canonical one-line verdict — the per-dimension detail belongs
 *    to the overlay, and the card must not grow a second rendering mode.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import {
  EvaluatorFailurePanel,
  projectEvaluationLines,
} from '@src/application/ui/tui/components/evaluator-failure-panel.tsx';
import { parseEvaluationMarkdown, type ParsedEvaluation } from '@src/business/task/parse-evaluation-md.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const ts = (sec: number): IsoTimestamp => new Date(Date.UTC(2026, 4, 20, 0, 0, sec)).toISOString() as IsoTimestamp;

const parsedEvaluation = (critique = 'short critique body'): ParsedEvaluation =>
  parseEvaluationMarkdown(
    [
      '# Evaluation — failed',
      '',
      `_${String(ts(1))}_`,
      '',
      '## Critique',
      '',
      critique,
      '',
      '## Dimensions',
      '',
      '### correctness — passed',
      '',
      'all good',
      '',
      '### completeness — failed',
      '',
      'missing edge case',
      '',
      '### docs — n/a',
      '',
      'no documentation surface in scope',
      '',
    ].join('\n')
  );

const failingSignal = (): EvaluationSignal => ({
  type: 'evaluation',
  status: 'failed',
  timestamp: ts(1),
  critique: 'short critique body',
  dimensions: [{ dimension: 'completeness', passed: false, finding: 'missing edge case' }],
});

const bucketedWith = (evaluation: EvaluationSignal): BucketedExecution => ({
  tasks: [{ id: 'task-1', status: 'running', subSteps: [], evaluations: [evaluation], signals: [], genEvalRound: 1 }],
  orphanSignals: [],
});

describe('EvaluatorFailurePanel — per-dimension render', () => {
  it('renders every dimension with its verdict word and finding', () => {
    const r = render(<EvaluatorFailurePanel parsed={parsedEvaluation()} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('correctness: passed');
    expect(frame).toContain('completeness: failed');
    expect(frame).toContain('all good');
    expect(frame).toContain('missing edge case');
    r.unmount();
  });

  it('renders the overall verdict and the recorded timestamp', () => {
    const frame = render(<EvaluatorFailurePanel parsed={parsedEvaluation()} />).lastFrame() ?? '';
    expect(frame).toContain('eval');
    expect(frame).toContain('failed');
    expect(frame).toContain(String(ts(1)));
  });

  it('renders an `n/a` dimension as neither pass nor fail', () => {
    // Regression fence — see the module docstring. The projection is asserted rather than the
    // frame because ANSI colour is stripped in tests; the verdict word is the visible carrier.
    const docs = projectEvaluationLines(parsedEvaluation()).find((l) => l.text.includes('docs:'));
    expect(docs?.text).toContain('docs: n/a');
    expect(docs?.text).not.toContain('failed');
    expect(docs?.text).not.toContain('passed');
    // Dim, so it carries no success/error colour at all.
    expect(docs?.color).toBeUndefined();
    expect(docs?.dim).toBe(true);
  });

  it('renders an `unknown` dimension with the themed unknown glyph and no colour', () => {
    // A dimension heading with no ` — verdict` tail parses to `unknown`. The glyph comes from the
    // theme (never an inline literal) and, like `n/a`, must stay uncoloured so the panel does not
    // report an undetermined verdict as a failure.
    const parsed = parseEvaluationMarkdown(
      ['# Evaluation — failed', '', '## Dimensions', '', '### flakiness', '', 'could not tell', ''].join('\n')
    );
    const row = projectEvaluationLines(parsed).find((l) => l.text.includes('flakiness:'));
    expect(row?.text).toContain('flakiness: unknown');
    expect(row?.text.startsWith(glyphs.unknownGlyph)).toBe(true);
    expect(row?.color).toBeUndefined();
    expect(row?.dim).toBe(true);
  });

  it('surfaces a dimension whose fenced execution evidence was recorded', () => {
    const parsed = parseEvaluationMarkdown(
      [
        '# Evaluation — failed',
        '',
        '## Dimensions',
        '',
        '### tests — failed',
        '',
        'red',
        '',
        '```',
        'FAIL foo',
        '```',
        '',
      ].join('\n')
    );
    expect(render(<EvaluatorFailurePanel parsed={parsed} />).lastFrame() ?? '').toContain('FAIL foo');
  });

  it('projects nothing for a model with no status, critique or dimensions', () => {
    // The empty projection is the overlay's signal to fall back to the raw file bytes.
    expect(projectEvaluationLines(parseEvaluationMarkdown('not markdown at all'))).toEqual([]);
  });
});

describe('EvaluatorFailurePanel — no excerpt, no keyboard', () => {
  it('renders a long critique in full instead of an excerpt with an expand affordance', () => {
    const longCritique = `${'a'.repeat(400)} TAIL-OF-CRITIQUE`;
    const frame = render(<EvaluatorFailurePanel parsed={parsedEvaluation(longCritique)} />).lastFrame() ?? '';
    expect(frame).toContain('TAIL-OF-CRITIQUE');
    expect(frame).not.toContain('press d to');
  });

  it('registers no input handler — pressing `d` does not change the frame', async () => {
    const r = render(<EvaluatorFailurePanel parsed={parsedEvaluation()} />);
    const before = r.lastFrame() ?? '';
    r.stdin.write('d');
    await tick(30);
    expect(r.lastFrame() ?? '').toBe(before);
    r.unmount();
  });
});

describe('TasksPanel — the card keeps its one-line verdict', () => {
  it('renders the authoritative verdict line and no per-dimension detail', () => {
    const r = render(
      <TasksPanel
        bucketed={bucketedWith(failingSignal())}
        running={true}
        taskEvaluationById={new Map([['task-1', { status: 'failed' as const, attemptN: 1 }]])}
      />
    );
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('eval');
    expect(frame).toContain('failed');
    expect(frame).toContain('attempt 1');
    // Dimension detail sourced from the bucketed signal stream must never reach the card.
    expect(frame).not.toContain('completeness: failed');
    expect(frame).not.toContain('missing edge case');
    r.unmount();
  });
});
