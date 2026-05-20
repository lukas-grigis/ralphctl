/**
 * CancelScopeOverlay — pressing `1` / `2` / `esc` fires the matching callback. The visible
 * waste-time + remaining-tasks hints surface in their expected shape.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { CancelScopeOverlay } from '@src/application/ui/tui/components/cancel-scope-overlay.tsx';
import { ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';

const noop = (): void => undefined;

describe('CancelScopeOverlay', () => {
  it('renders both options with the wasted-time hint and the remaining-tasks count', () => {
    const { lastFrame } = render(
      <CancelScopeOverlay
        attemptElapsedMs={2 * 60 * 1000 + 30 * 1000}
        remainingTaskCount={3}
        onCancelAttempt={noop}
        onCancelFlow={noop}
        onDismiss={noop}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Cancel — pick a scope');
    expect(frame).toContain('Cancel current attempt');
    expect(frame).toContain('Cancel whole flow');
    expect(frame).toContain('~2m30s of generator output discarded');
    expect(frame).toContain('2 other tasks still queued');
  });

  it('omits the wasted-time hint when no attempt has started yet', () => {
    const { lastFrame } = render(
      <CancelScopeOverlay
        attemptElapsedMs={undefined}
        remainingTaskCount={1}
        onCancelAttempt={noop}
        onCancelFlow={noop}
        onDismiss={noop}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('of generator output discarded');
    expect(frame).toContain('no other tasks queued');
  });

  it('invokes onCancelAttempt when `1` is pressed', async () => {
    const onCancelAttempt = vi.fn();
    const onCancelFlow = vi.fn();
    const onDismiss = vi.fn();
    const { stdin } = render(
      <CancelScopeOverlay
        attemptElapsedMs={1000}
        remainingTaskCount={1}
        onCancelAttempt={onCancelAttempt}
        onCancelFlow={onCancelFlow}
        onDismiss={onDismiss}
      />
    );
    stdin.write('1');
    await tick();
    expect(onCancelAttempt).toHaveBeenCalledTimes(1);
    expect(onCancelFlow).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('invokes onCancelFlow when `2` is pressed', async () => {
    const onCancelAttempt = vi.fn();
    const onCancelFlow = vi.fn();
    const onDismiss = vi.fn();
    const { stdin } = render(
      <CancelScopeOverlay
        attemptElapsedMs={1000}
        remainingTaskCount={2}
        onCancelAttempt={onCancelAttempt}
        onCancelFlow={onCancelFlow}
        onDismiss={onDismiss}
      />
    );
    stdin.write('2');
    await tick();
    expect(onCancelFlow).toHaveBeenCalledTimes(1);
  });

  it('invokes onDismiss when esc is pressed', async () => {
    const onDismiss = vi.fn();
    const { stdin } = render(
      <CancelScopeOverlay
        attemptElapsedMs={1000}
        remainingTaskCount={1}
        onCancelAttempt={noop}
        onCancelFlow={noop}
        onDismiss={onDismiss}
      />
    );
    stdin.write(ESC);
    await tick();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
