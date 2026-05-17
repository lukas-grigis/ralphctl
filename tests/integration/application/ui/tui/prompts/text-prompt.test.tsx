/**
 * Render tests for TextPrompt. Verifies typed characters land in the buffer, ctrl+u clears,
 * ctrl+w drops the previous word, Enter calls onSubmit with the buffer, and Esc calls
 * onCancel. The blinking caret is not asserted (timer-driven; would require fake timers).
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { CTRL_U, CTRL_W, ENTER, ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';

describe('TextPrompt', () => {
  it('appends typed characters to the buffer', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('blinced');
    await tick();
    expect(lastFrame()).toContain('blinced');
    unmount();
  });

  it('submits the buffer on Enter', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('hello');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hello');
    unmount();
  });

  it('cancels on Esc', async () => {
    const onCancel = vi.fn();
    const { stdin, unmount } = render(<TextPrompt message="Name" onSubmit={() => undefined} onCancel={onCancel} />);
    stdin.write(ESC);
    await tick(150);
    expect(onCancel).toHaveBeenCalled();
    unmount();
  });

  it('ctrl+u clears the buffer', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('hello');
    await tick();
    stdin.write(CTRL_U);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('');
    unmount();
  });

  it('ctrl+w drops the previous word', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(<TextPrompt message="Name" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('hello world');
    await tick();
    stdin.write(CTRL_W);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hello ');
    unmount();
  });

  it('seeds the buffer from `initial` and submits it as-is', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <TextPrompt message="Name" initial="seed" onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('seed');
    unmount();
  });
});
