/**
 * Gen-eval busy indicator (REQ-4) — the two-item activity line on an expanded, active,
 * spinning task card, plus the {@link resolveActiveRole} heuristic that drives it.
 *
 * Two halves:
 *   1. {@link resolveActiveRole} unit tests — pure trace → role mapping. The chain trace is
 *      terminal-only (an entry lands when a leaf COMPLETES), so the tail entry is read to
 *      resolve the live role. The `.includes` match is intentional and load-bearing: while a
 *      role runs, the immediately-preceding `stamp-role-meta-<role>` sidecar is the tail entry.
 *      This is where the bright-vs-dim *decision* is fully exercised.
 *   2. {@link BusyIndicator} render tests — structural assertions on the rendered frame. The
 *      busy / idle distinction is colour-only (`inkColors.info` vs `dimColor`), and the non-TTY
 *      test runner strips colour (chalk resolves its level at import, before any per-test env
 *      mutation), so colour bytes are not asserted here — the role→brightness mapping is proven
 *      by the unit suite above; these tests pin label presence, the busyDot glyph, and ordering.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { BusyIndicator } from '@src/application/ui/tui/components/tasks-panel-internals/task-card-parts.tsx';
import { resolveActiveRole } from '@src/application/ui/tui/components/tasks-panel-internals/format.ts';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const step = (leafName: string): { readonly leafName: string } => ({ leafName });

describe('resolveActiveRole', () => {
  it('resolves a bare generator tail entry to "generator"', () => {
    expect(resolveActiveRole([step('generator')])).toBe('generator');
  });

  it('resolves a bare evaluator tail entry to "evaluator"', () => {
    expect(resolveActiveRole([step('evaluator')])).toBe('evaluator');
  });

  it('resolves a stamp-role-meta-generator sidecar tail to "generator" (proves .includes is intended)', () => {
    // While the generator runs, the terminal trace tail is its preceding stamp sidecar — the
    // role substring is embedded, not the whole leaf name.
    expect(resolveActiveRole([step('stamp-role-meta-generator')])).toBe('generator');
  });

  it('resolves a stamp-role-meta-evaluator sidecar tail to "evaluator"', () => {
    expect(resolveActiveRole([step('stamp-role-meta-evaluator')])).toBe('evaluator');
  });

  it('returns undefined for a non-role tail (finalize-gen-eval / commit-task)', () => {
    expect(resolveActiveRole([step('finalize-gen-eval')])).toBeUndefined();
    expect(resolveActiveRole([step('commit-task')])).toBeUndefined();
  });

  it('returns undefined for an empty trace (pre-first-attempt)', () => {
    expect(resolveActiveRole([])).toBeUndefined();
  });

  it('lets the LAST entry win when the trace holds multiple role entries', () => {
    // generator ran, then evaluator ran — the tail (evaluator) is the live role, not generator.
    expect(
      resolveActiveRole([step('stamp-role-meta-generator'), step('generator'), step('stamp-role-meta-evaluator')])
    ).toBe('evaluator');
    // …and the inverse ordering resolves to generator.
    expect(
      resolveActiveRole([step('stamp-role-meta-evaluator'), step('evaluator'), step('stamp-role-meta-generator')])
    ).toBe('generator');
  });
});

describe('BusyIndicator', () => {
  it('renders both roles with the busyDot glyph for every variant', () => {
    for (const role of ['generator', 'evaluator', undefined] as const) {
      const r = render(<BusyIndicator role={role} />);
      const frame = r.lastFrame() ?? '';
      expect(frame).toContain('generator');
      expect(frame).toContain('evaluator');
      // The heavy busy dot appears once per role.
      expect(frame.split(glyphs.busyDot).length - 1).toBe(2);
      r.unmount();
    }
  });

  it('renders generator before evaluator (stable left-to-right order)', () => {
    const r = render(<BusyIndicator role="generator" />);
    const frame = r.lastFrame() ?? '';
    expect(frame.indexOf('generator')).toBeLessThan(frame.indexOf('evaluator'));
    r.unmount();
  });
});

/**
 * Card-level gate (task-row.tsx): the busy indicator renders only when
 * `cardExpanded && isActive && isSpinning`. The busy dot glyph is unique to this line, so its
 * presence / absence in the rendered frame is a reliable gate probe through TasksPanel.
 */
describe('BusyIndicator card gate (via TasksPanel)', () => {
  const activeBucket: BucketedExecution = {
    tasks: [
      {
        id: 'task-active',
        status: 'running',
        subSteps: [{ leafName: 'stamp-role-meta-generator', status: 'completed', durationMs: 5 }],
        evaluations: [],
        signals: [],
        genEvalRound: 1,
      },
    ],
    orphanSignals: [],
  };

  it('renders the busy dot for an active, spinning, auto-expanded task', async () => {
    const r = render(<TasksPanel bucketed={activeBucket} running={true} />);
    await tick(40);
    expect(r.lastFrame() ?? '').toContain(glyphs.busyDot);
    r.unmount();
  });

  it('does NOT render the busy dot for a completed (non-active, non-spinning) task', async () => {
    const completed: BucketedExecution = {
      tasks: [{ ...activeBucket.tasks[0]!, status: 'completed' }],
      orphanSignals: [],
    };
    const r = render(<TasksPanel bucketed={completed} running={false} />);
    await tick(40);
    expect(r.lastFrame() ?? '').not.toContain(glyphs.busyDot);
    r.unmount();
  });
});

/**
 * Edge case (task-row.tsx): an expanded active card with no AUTHORITATIVE evaluation yet shows a
 * single dim "awaiting eval" placeholder. Once an authoritative verdict exists (via
 * `taskEvaluationById`, sourced from the task entity by the host) the placeholder is replaced by
 * the verdict line. Gating is on the ABSENCE of an authoritative verdict — NOT the bucketed signal
 * stream, which can mis-attribute a stale signal under parallel sprints.
 */
describe('awaiting-eval placeholder (via TasksPanel)', () => {
  const activeNoEval: BucketedExecution = {
    tasks: [
      {
        id: 'task-active',
        status: 'running',
        subSteps: [],
        evaluations: [],
        signals: [],
        genEvalRound: 1,
      },
    ],
    orphanSignals: [],
  };

  it('shows "awaiting eval" on an active, auto-expanded card with no authoritative evaluation', async () => {
    const r = render(<TasksPanel bucketed={activeNoEval} running={true} />);
    await tick(40);
    expect(r.lastFrame() ?? '').toContain('awaiting eval');
    r.unmount();
  });

  it('replaces the placeholder once an authoritative evaluation exists', async () => {
    const r = render(
      <TasksPanel
        bucketed={activeNoEval}
        running={true}
        taskEvaluationById={new Map([['task-active', { status: 'passed' as const, attemptN: 1 }]])}
      />
    );
    await tick(40);
    const frame = r.lastFrame() ?? '';
    expect(frame).not.toContain('awaiting eval');
    expect(frame).toContain('passed');
    r.unmount();
  });

  it('does NOT show "awaiting eval" on a non-active completed card', async () => {
    const completedNoEval: BucketedExecution = {
      tasks: [{ ...activeNoEval.tasks[0]!, status: 'completed' }],
      orphanSignals: [],
    };
    const r = render(<TasksPanel bucketed={completedNoEval} running={false} />);
    await tick(40);
    expect(r.lastFrame() ?? '').not.toContain('awaiting eval');
    r.unmount();
  });
});
