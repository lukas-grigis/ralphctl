/**
 * Render tests for ConfirmPrompt. Verifies y/n shortcuts, Enter submits the focused choice,
 * defaultYes flips the initial focus, and ←/→ moves between choices.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { ENTER, ESC, LEFT, RIGHT, tick } from '@tests/integration/application/ui/tui/_keys.ts';

describe('ConfirmPrompt', () => {
  it('y commits true', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(<ConfirmPrompt message="Save?" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('y');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(true);
    unmount();
  });

  it('n commits false', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(<ConfirmPrompt message="Save?" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write('n');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(false);
    unmount();
  });

  it('Enter submits the focused choice (defaults to Yes)', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(<ConfirmPrompt message="Save?" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(true);
    unmount();
  });

  it('defaultYes=false flips the Enter target to No', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <ConfirmPrompt message="Delete?" defaultYes={false} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(false);
    unmount();
  });

  it('→ then Enter submits No when default was Yes', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(<ConfirmPrompt message="Save?" onSubmit={onSubmit} onCancel={() => undefined} />);
    stdin.write(RIGHT);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(false);
    unmount();
  });

  it('← then Enter submits Yes after toggling back', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <ConfirmPrompt message="Delete?" defaultYes={false} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write(LEFT);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(true);
    unmount();
  });

  it('Esc cancels', async () => {
    const onCancel = vi.fn();
    const { stdin, unmount } = render(<ConfirmPrompt message="Save?" onSubmit={() => undefined} onCancel={onCancel} />);
    stdin.write(ESC);
    await tick(150);
    expect(onCancel).toHaveBeenCalled();
    unmount();
  });
});
