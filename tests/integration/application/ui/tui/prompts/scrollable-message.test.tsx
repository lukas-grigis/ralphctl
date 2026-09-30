/**
 * ScrollableMessage — body window is sized to the terminal, long lines wrap instead of breaking the
 * row budget, and the "lines x–y of N" hint is reachable via arrows (default) / PgDn.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ScrollableMessage } from '@src/application/ui/tui/prompts/scrollable-message.tsx';
import { DOWN, tick } from '@tests/integration/application/ui/tui/_keys.ts';

const bodyOf = (n: number): string => Array.from({ length: n }, (_, i) => `body line ${String(i + 1)}`).join('\n');

describe('ScrollableMessage', () => {
  it('shows a range hint and a window sized from the terminal rows (24 default)', async () => {
    const { lastFrame, unmount } = render(<ScrollableMessage message={`Head\n\n${bodyOf(60)}`} />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('lines 1–8 of 60');
    expect(frame).toContain('body line 8');
    expect(frame).not.toContain('body line 9');
    unmount();
  });

  it('↓ scrolls the body when the host does not own arrows', async () => {
    const { stdin, lastFrame, unmount } = render(<ScrollableMessage message={`Head\n\n${bodyOf(60)}`} />);
    await tick();
    for (let i = 0; i < 12; i += 1) stdin.write(DOWN);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('lines 13–20 of 60');
    expect(frame).not.toContain('body line 1\n');
    unmount();
  });

  it('PgDn pages the body', async () => {
    const { stdin, lastFrame, unmount } = render(
      <ScrollableMessage message={`Head\n\n${bodyOf(60)}`} ownsArrows={false} />
    );
    await tick();
    stdin.write('\u001B[6~');
    await tick();
    expect(lastFrame() ?? '').toContain('lines 9–16 of 60');
    unmount();
  });

  it('wraps an over-wide line so no content is lost', async () => {
    const long = `verify: ${'word '.repeat(60)}END-MARKER`;
    const { lastFrame, unmount } = render(<ScrollableMessage message={`Head\n\n${long}`} />);
    await tick();
    expect(lastFrame() ?? '').toContain('END-MARKER');
    unmount();
  });

  it('reservedRows shrinks the window down to the MIN_BODY_ROWS floor', async () => {
    const { lastFrame, unmount } = render(<ScrollableMessage message={`Head\n\n${bodyOf(60)}`} reservedRows={3} />);
    await tick();
    expect(lastFrame() ?? '').toContain('lines 1–5 of 60');
    unmount();
  });

  it('re-clamps a stale offset when the terminal grows, without a keypress', async () => {
    const { stdin, stdout, lastFrame, unmount } = render(<ScrollableMessage message={`Head\n\n${bodyOf(60)}`} />);
    await tick();
    for (let i = 0; i < 8; i += 1) stdin.write('\u001B[6~');
    await tick();
    expect(lastFrame() ?? '').toContain('lines 53–60 of 60');
    (stdout as unknown as { rows: number }).rows = 40;
    stdout.emit('resize');
    await tick();
    expect(lastFrame() ?? '').toContain('lines 37–60 of 60');
    unmount();
  });

  it('grows the window when the terminal gets taller', async () => {
    const { stdout, lastFrame, unmount } = render(<ScrollableMessage message={`Head\n\n${bodyOf(60)}`} />);
    await tick();
    expect(lastFrame() ?? '').toContain('lines 1–8 of 60');
    (stdout as unknown as { rows: number }).rows = 40;
    stdout.emit('resize');
    await tick();
    expect(lastFrame() ?? '').toContain('lines 1–24 of 60');
    unmount();
  });

  it('counts wrapped rows in the total and keeps the indent on continuation rows', async () => {
    const long = `    ${'word '.repeat(60)}END-MARKER`;
    const { lastFrame, unmount } = render(<ScrollableMessage message={`Head\n\n${long}\n${bodyOf(20)}`} />);
    await tick();
    const frame = lastFrame() ?? '';
    const total = /of (\d+)/.exec(frame)?.[1];
    expect(Number(total)).toBeGreaterThan(21);
    const rows = frame.split('\n').filter((l) => l.includes('word'));
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r).toMatch(/│ {5}word/);
    unmount();
  });
});
