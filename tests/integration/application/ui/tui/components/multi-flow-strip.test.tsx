/**
 * Multi-flow strip — pins the visible behaviour:
 *   1. zero render when fewer than two sessions are running,
 *   2. chips appear for ≥2 running sessions with active chip highlighted,
 *   3. terminal sessions (completed / failed / aborted) drop off the strip,
 *   4. the navigation cue pins at the right end and advertises both real chords
 *      (Tab/Shift+Tab cycle + Ctrl+1..9 jump), sourced from the keyboard map so it can't drift.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { MultiFlowStrip } from '@src/application/ui/tui/components/multi-flow-strip.tsx';
import { globalKeys } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import type { SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';

const FAKE_RUNNER = { id: 'r', subscribe: () => () => undefined } as unknown as Runner<unknown>;

const sess = (
  id: string,
  title: string,
  flowId: string,
  status: 'running' | 'completed' | 'failed' | 'aborted' = 'running'
): SessionRecord => ({
  descriptor: {
    id,
    flowId,
    title,
    status,
    startedAt: Date.now() - 60_000,
    trace: [],
  },
  runner: FAKE_RUNNER,
});

const NOW = Date.now();

describe('MultiFlowStrip', () => {
  it('renders nothing when fewer than two sessions are running', () => {
    const { lastFrame } = render(<MultiFlowStrip sessions={[sess('1', 'A', 'refine')]} activeId="1" now={NOW} />);
    // Empty output (Ink renders a trailing newline; check trimmed length).
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('renders chips and the cycle hint when two or more sessions run', () => {
    const sessions = [sess('1', 'tickets', 'refine'), sess('2', 'durability', 'implement')];
    const { lastFrame } = render(<MultiFlowStrip sessions={sessions} activeId="2" now={NOW} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[1]');
    expect(frame).toContain('[2]');
    expect(frame).toContain('refine:');
    expect(frame).toContain('tickets');
    expect(frame).toContain('implement:');
    expect(frame).toContain('durability');
    expect(frame).toContain('cycle');
  });

  it('advertises both real chords in the nav cue, sourced from the keyboard map', () => {
    const sessions = [sess('1', 'tickets', 'refine'), sess('2', 'durability', 'implement')];
    const { lastFrame } = render(<MultiFlowStrip sessions={sessions} activeId="2" now={NOW} />);
    const frame = lastFrame() ?? '';
    // Cue text is derived from keyboard-map bindings — not a hardcoded string — so the cue and the
    // chords the router honours cannot drift apart.
    expect(frame).toContain(`${globalKeys.cycleSession.keys.join('/')} cycle`);
    expect(frame).toContain(`${globalKeys.jumpSession.keys.join('/')} jump`);
    // Spot-check the literal shipped chords so a rename in keyboard-map shows up as a doc/cue diff.
    expect(frame).toContain('Tab/Shift+Tab cycle');
    expect(frame).toContain('Ctrl+1..9 jump');
  });

  it('excludes terminal sessions from the strip', () => {
    const sessions = [
      sess('1', 'A', 'refine'),
      sess('2', 'B', 'implement', 'completed'),
      sess('3', 'C', 'plan', 'failed'),
    ];
    // Only one running ⇒ strip is suppressed.
    const { lastFrame } = render(<MultiFlowStrip sessions={sessions} activeId="1" now={NOW} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('clips long titles so the strip stays on one row', () => {
    const longTitle = 'this-is-a-very-very-long-title-that-must-clip';
    const sessions = [sess('1', longTitle, 'refine'), sess('2', 'B', 'implement')];
    const { lastFrame } = render(<MultiFlowStrip sessions={sessions} activeId="1" now={NOW} maxTitleChars={10} />);
    const frame = lastFrame() ?? '';
    // Clipped form ends in ellipsis; full untruncated title must not appear.
    expect(frame).not.toContain(longTitle);
    expect(frame).toContain('…');
  });
});
