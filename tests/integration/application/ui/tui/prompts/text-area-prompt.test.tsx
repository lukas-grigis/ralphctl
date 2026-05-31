/**
 * Render tests for TextAreaPrompt. Mirrors the TextPrompt suite plus the multi-line behaviours
 * that justify a separate component: backslash+Enter inserts a newline, paste with embedded
 * `\n` is preserved, plain Enter still submits the whole buffer.
 *
 * Also covers cursor navigation: arrow keys, home/end, ↑/↓ multi-line navigation with
 * desiredColumn preservation, ctrl+w from mid-line, paste at cursor.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { TextAreaPrompt } from '@src/application/ui/tui/prompts/text-area-prompt.tsx';
import {
  CTRL_A,
  CTRL_E,
  CTRL_J,
  CTRL_U,
  CTRL_W,
  DOWN,
  END,
  ENTER,
  ESC,
  HOME,
  LEFT,
  RIGHT,
  tick,
  UP,
} from '@tests/integration/application/ui/tui/_keys.ts';

describe('TextAreaPrompt', () => {
  it('appends typed characters to the buffer', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('hello');
    await tick();
    expect(lastFrame()).toContain('hello');
    unmount();
  });

  it('submits the buffer on plain Enter', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('one line');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('one line');
    unmount();
  });

  it('backslash + Enter inserts a newline instead of submitting', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('line1\\');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write('line2');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('line1\nline2');
    unmount();
  });

  it('preserves newlines in pasted content', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('a\nb\nc');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('a\nb\nc');
    unmount();
  });

  it('renders one row per line', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('first\nsecond');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('first');
    expect(frame).toContain('second');
    // Both lines should be on separate rows of the rendered frame.
    const lines = frame.split('\n');
    const firstRow = lines.findIndex((l) => l.includes('first'));
    const secondRow = lines.findIndex((l) => l.includes('second'));
    expect(secondRow).toBeGreaterThan(firstRow);
    unmount();
  });

  it('cancels on Esc', async () => {
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={() => undefined} onCancel={onCancel} />
    );
    stdin.write(ESC);
    await tick(150);
    expect(onCancel).toHaveBeenCalled();
    unmount();
  });

  it('ctrl+u clears the buffer (including newlines)', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('line1\nline2');
    await tick();
    stdin.write(CTRL_U);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('');
    unmount();
  });

  it('ctrl+w drops the previous word across line boundaries', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('line1\nhello world');
    await tick();
    stdin.write(CTRL_W);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('line1\nhello ');
    unmount();
  });

  it('renders the configured escLabel in the hint row', async () => {
    const { lastFrame, unmount } = render(
      <TextAreaPrompt message="Description" escLabel="back" onSubmit={() => undefined} onCancel={() => undefined} />
    );
    await tick();
    expect(lastFrame()).toContain('esc back');
    unmount();
  });

  it('seeds the buffer from `initial` and submits it as-is', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" initial={'seeded\nvalue'} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('seeded\nvalue');
    unmount();
  });

  it('ctrl+j inserts a newline at cursor', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('ab');
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write(CTRL_J);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('a\nb');
    unmount();
  });

  it('left/right arrow moves cursor; backspace deletes char before cursor', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('abc');
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write('\x7f'); // backspace
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('bc');
    unmount();
  });

  it('inserts typed char at cursor (mid-line insert)', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('ac');
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write('b');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('abc');
    unmount();
  });

  it('up arrow moves cursor to previous line at same column', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    // "abc\nde" — cursor at end (offset 6, col 2 on line 1).
    // After UP: col 2 on line 0 = offset 2 (pointing at 'c').
    // Backspace removes the char *before* the cursor = index 1 = 'b', leaving "ac\nde".
    stdin.write('abc\nde');
    await tick();
    stdin.write(UP);
    await tick();
    stdin.write('\x7f'); // backspace: removes char before cursor = 'b' at index 1
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('ac\nde');
    unmount();
  });

  it('down arrow moves cursor to next line at same column', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    // "ab\ncde" — navigate to offset 1 (after 'a' on line 0), then DOWN.
    // DOWN from line 0 col 1 → line 1 col 1 = offset 4 (pointing at 'd').
    // Backspace removes char before cursor = offset 3 = 'c', leaving "ab\nde".
    stdin.write('ab\ncde');
    await tick();
    stdin.write(UP); // go to line 0
    await tick();
    stdin.write(HOME); // jump to start of line 0
    await tick();
    stdin.write(RIGHT);
    await tick(); // cursor at offset 1 (after 'a' on line 0)
    stdin.write(DOWN); // go to line 1 col 1 = offset 4
    await tick();
    stdin.write('\x7f'); // backspace: removes char at offset 3 = 'c', leaving "ab\nde"
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('ab\nde');
    unmount();
  });

  it('up/down snaps to end-of-line when target line is shorter', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    // "a\nbbbbb" — cursor at end of line 1 (col 5)
    // UP → line 0 has length 1, so cursor snaps to col 1 (end of "a")
    // Then typing 'X' inserts after 'a'.
    stdin.write('a\nbbbbb');
    await tick();
    stdin.write(UP);
    await tick();
    stdin.write('X');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('aX\nbbbbb');
    unmount();
  });

  it('home / ctrl+a jumps to start of current line; end / ctrl+e to end', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('first\nsecond');
    await tick();
    stdin.write(HOME);
    await tick();
    stdin.write('X');
    await tick();
    stdin.write(END);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('first\nXsecond');
    unmount();
  });

  it('ctrl+a / ctrl+e work as home/end aliases on current line', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('first\nsecond');
    await tick();
    stdin.write(CTRL_A);
    await tick();
    stdin.write('X');
    await tick();
    stdin.write(CTRL_E);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('first\nXsecond');
    unmount();
  });

  it('ctrl+w from mid-line deletes word before cursor only', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('line1\nhello world');
    await tick();
    // Move left 5 chars to put cursor before "world".
    for (let i = 0; i < 5; i++) {
      stdin.write(LEFT);
      await tick();
    }
    stdin.write(CTRL_W);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('line1\nworld');
    unmount();
  });

  it('paste at cursor inserts multi-char content at the right position', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextAreaPrompt message="Description" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('ac');
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write('b\nx'); // paste with newline mid-content
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('ab\nxc');
    unmount();
  });
});
