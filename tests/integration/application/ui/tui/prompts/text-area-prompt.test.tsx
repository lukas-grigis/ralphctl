/**
 * Render tests for TextAreaPrompt. Mirrors the TextPrompt suite plus the multi-line behaviours
 * that justify a separate component: backslash+Enter inserts a newline, paste with embedded
 * `\n` is preserved, plain Enter still submits the whole buffer.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { TextAreaPrompt } from '@src/application/ui/tui/prompts/text-area-prompt.tsx';
import { CTRL_U, CTRL_W, ENTER, ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';

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
});
