/**
 * Render tests for TextPrompt. Verifies typed characters land in the buffer, cursor navigation
 * works (arrows, home/end, ctrl+a/ctrl+e), mid-line insert/backspace, ctrl+w from mid-buffer,
 * paste at cursor, ctrl+u clear, Enter submit, and Esc cancel.
 * The blinking caret is not asserted (timer-driven; would require fake timers).
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import {
  CTRL_A,
  CTRL_E,
  CTRL_U,
  CTRL_W,
  END,
  ENTER,
  ESC,
  HOME,
  LEFT,
  RIGHT,
  tick,
} from '@tests/integration/application/ui/tui/_keys.ts';

/** Wrap a payload in bracketed-paste markers (DEC mode 2004). */
const PASTE_START = `${String.fromCharCode(27)}[200~`;
const PASTE_END = `${String.fromCharCode(27)}[201~`;
const bracketed = (payload: string): string => `${PASTE_START}${payload}${PASTE_END}`;

describe('TextPrompt', () => {
  it('appends typed characters to the buffer', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('blinced');
    await tick();
    expect(lastFrame()).toContain('blinced');
  });

  it('submits the buffer on Enter', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('hello');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hello');
  });

  it('cancels on Esc', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={() => undefined} onCancel={onCancel} />);
    stdin.write(ESC);
    await tick(150);
    expect(onCancel).toHaveBeenCalled();
  });

  it('ctrl+u clears the buffer', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('hello');
    await tick();
    stdin.write(CTRL_U);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('');
  });

  it('ctrl+w drops the previous word', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('hello world');
    await tick();
    stdin.write(CTRL_W);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hello ');
  });

  it('seeds the buffer from `initial` and submits it as-is', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <TextPrompt message="Name" initial="seed" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('seed');
  });

  it('left/right arrow moves cursor; backspace deletes before cursor', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    // Type "abc", move left twice (cursor between a and b), backspace deletes 'a'.
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
  });

  it('inserts typed char at cursor (mid-line insert)', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    // Type "ac", move left, insert 'b' to get "abc".
    stdin.write('ac');
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write('b');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('abc');
  });

  it('home / ctrl+a jumps to start; end / ctrl+e jumps to end', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('hello');
    await tick();
    stdin.write(HOME);
    await tick();
    // Cursor at start — typing inserts at position 0.
    stdin.write('X');
    await tick();
    stdin.write(END);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('Xhello');
  });

  it('ctrl+a / ctrl+e work as home/end aliases', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('hello');
    await tick();
    stdin.write(CTRL_A);
    await tick();
    stdin.write('X');
    await tick();
    stdin.write(CTRL_E);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('Xhello');
  });

  it('ctrl+w from mid-line deletes word before cursor only', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    // Type "hello world", move cursor back before "world", then ctrl+w.
    stdin.write('hello world');
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
    expect(onSubmit).toHaveBeenCalledWith('world');
  });

  it('paste at cursor inserts content at the right position', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('ac');
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write('b'); // simulates pasting 'b' at the cursor between 'a' and 'c'
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('abc');
  });

  it('right arrow does not go past end of buffer', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('hi');
    await tick();
    stdin.write(RIGHT);
    await tick();
    stdin.write(RIGHT);
    await tick();
    stdin.write('!');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hi!');
  });

  it('flattens a multi-line bracketed paste to a single line and does NOT submit', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write(bracketed('first line\r\nsecond line'));
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('first line second line');
  });

  it('does not submit when the pasted payload is a lone carriage return', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('ab');
    await tick();
    stdin.write(bracketed('\r'));
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('never leaks bracketed-paste marker bytes into a single-line field', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write(bracketed('clean'));
    await tick();
    expect(lastFrame()).not.toContain('200~');
    expect(lastFrame()).not.toContain('201~');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('clean');
  });

  it('inserts a flattened bracketed paste at the cursor position', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('ac');
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write(bracketed('b1\nb2'));
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('ab1 b2c');
  });

  it('fallback: a single-chunk multi-line paste (no markers) is flattened to spaces', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('alpha\r\nbeta');
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('alpha beta');
  });

  it('still inserts a typed space verbatim (not collapsed by the paste fallback)', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('a');
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write('b');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('a b');
  });

  it('genuine Enter still submits', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('typed');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('typed');
  });

  it('does not re-run validate on a caret-blink render', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const validate = vi.fn((): string | undefined => undefined);
      const { stdin, unmount } = render(
        <TextPrompt message="Name" onSubmit={() => undefined} onCancel={() => undefined} validate={validate} />
      );
      stdin.write('abc');
      await vi.advanceTimersByTimeAsync(0);
      const afterTyping = validate.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(validate.mock.calls.length).toBe(afterTyping);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the submit buffer exact when state updaters are replayed (StrictMode)', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <React.StrictMode>
        <TextPrompt message="Name" initial="ab" onSubmit={onSubmit} onCancel={() => undefined} />
      </React.StrictMode>
    );
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write('x');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('axb');
  });
});
