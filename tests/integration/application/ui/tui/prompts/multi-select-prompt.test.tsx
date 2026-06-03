/**
 * Render tests for MultiSelectPrompt. Covers short-list rendering (no windowing), long-list
 * windowing (only the visible slice rendered, focused option always in view after navigation),
 * and selection persistence across scroll (picked references original indices).
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { MultiSelectPrompt } from '@src/application/ui/tui/prompts/multi-select-prompt.tsx';
import type { Choice } from '@src/business/interactive/prompt.ts';
import { DOWN, ENTER, ESC, tick, UP } from '@tests/integration/application/ui/tui/_keys.ts';

const shortOptions: ReadonlyArray<Choice<unknown>> = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'bravo', label: 'Bravo' },
  { value: 'charlie', label: 'Charlie' },
];

const longOptions: ReadonlyArray<Choice<unknown>> = Array.from({ length: 20 }, (_, i) => ({
  value: `value-${String(i)}`,
  label: `Label-${String(i)}`,
}));

describe('MultiSelectPrompt', () => {
  it('space toggles the focused option and Enter submits the selection', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <MultiSelectPrompt message="Pick" options={shortOptions} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write(' ');
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(['alpha', 'bravo']);
    unmount();
  });

  it('a selects all and Enter submits every value', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <MultiSelectPrompt message="Pick" options={shortOptions} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('a');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(['alpha', 'bravo', 'charlie']);
    unmount();
  });

  it('n clears the selection after select-all', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <MultiSelectPrompt message="Pick" options={shortOptions} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('a');
    await tick();
    stdin.write('n');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith([]);
    unmount();
  });

  it('Esc cancels', async () => {
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      <MultiSelectPrompt message="Pick" options={shortOptions} onSubmit={() => undefined} onCancel={onCancel} />
    );
    stdin.write(UP); // no-op at top
    await tick();
    stdin.write(ESC);
    await tick(150);
    expect(onCancel).toHaveBeenCalled();
    unmount();
  });

  it('renders every option in the initial frame when the list is short', async () => {
    const { lastFrame, unmount } = render(
      <MultiSelectPrompt message="Pick" options={shortOptions} onSubmit={() => undefined} onCancel={() => undefined} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Alpha');
    expect(frame).toContain('Bravo');
    expect(frame).toContain('Charlie');
    // Position indicator should NOT appear when list fits the window.
    expect(frame).not.toMatch(/\bof 3\b/);
    unmount();
  });

  it('hint advertises ↑/↓ move (the cursor-movement keys it handles)', async () => {
    const { lastFrame, unmount } = render(
      <MultiSelectPrompt message="Pick" options={shortOptions} onSubmit={() => undefined} onCancel={() => undefined} />
    );
    await tick();
    expect(lastFrame() ?? '').toContain('↑/↓ move');
    unmount();
  });

  it('renders only the windowed slice when the list exceeds VISIBLE_ROWS', async () => {
    const { lastFrame, unmount } = render(
      <MultiSelectPrompt message="Pick" options={longOptions} onSubmit={() => undefined} onCancel={() => undefined} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    // First 8 options (Label-0..Label-7) are visible; later options are clipped.
    expect(frame).toContain('Label-0');
    expect(frame).toContain('Label-7');
    expect(frame).not.toContain('Label-10');
    expect(frame).not.toContain('Label-19');
    // Position indicator surfaces the cursor over total.
    expect(frame).toContain('1 of 20');
    unmount();
  });

  it('scrolls the window so the new focused option is visible after navigating past it', async () => {
    const { stdin, lastFrame, unmount } = render(
      <MultiSelectPrompt message="Pick" options={longOptions} onSubmit={() => undefined} onCancel={() => undefined} />
    );
    await tick();
    for (let i = 0; i < 10; i++) {
      stdin.write(DOWN);
      await tick();
    }
    const frame = lastFrame() ?? '';
    // Cursor at index 10 must be on screen; Label-0 has scrolled out.
    expect(frame).toContain('Label-10');
    expect(frame).not.toContain('Label-0 ');
    expect(frame).toContain('11 of 20');
    unmount();
  });

  it('selection survives scrolling: toggling option 0 then scrolling out and back keeps [x] on option 0', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <MultiSelectPrompt message="Pick" options={longOptions} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    await tick();
    // Toggle option 0.
    stdin.write(' ');
    await tick();
    // Scroll down past option 0 so it leaves the window.
    for (let i = 0; i < 10; i++) {
      stdin.write(DOWN);
      await tick();
    }
    // Option 0 should be out of frame now (visible window is around Label-6..Label-13).
    const midFrame = lastFrame() ?? '';
    expect(midFrame).not.toContain('Label-0 ');
    expect(midFrame).toContain('Label-10');
    // Scroll back to the top.
    for (let i = 0; i < 10; i++) {
      stdin.write(UP);
      await tick();
    }
    const finalFrame = lastFrame() ?? '';
    // Option 0 is back in view with its checkbox marked.
    expect(finalFrame).toContain('Label-0');
    expect(finalFrame).toMatch(/\[[xX✔✓]]\s*Label-0/);
    // Submit and confirm the original-index reference is preserved end-to-end.
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(['value-0']);
    unmount();
  });
});
