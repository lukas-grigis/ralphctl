/** Leaving the Execute view inside the toast window must clear "Copied to clipboard", not strand it. */

import React, { useEffect } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { useYankTask } from '@src/application/ui/tui/views/execute-view-internals/use-yank-task.ts';

const copy = vi.hoisted(() => ({ release: undefined as (() => void) | undefined, gate: false }));
vi.mock('@src/integration/io/clipboard.ts', () => ({
  createCopyToClipboard: () => async () => {
    if (copy.gate) await new Promise<void>((r) => (copy.release = r));
    return Result.ok(undefined);
  },
}));

const mount = (): { types: () => string[]; unmount: () => void } => {
  const published: Array<{ type: string }> = [];
  const bus = {
    publish: (e: { type: string }) => published.push(e),
    subscribe: () => () => undefined,
  } as unknown as EventBus;
  const Probe = (): React.JSX.Element => {
    const yank = useYankTask({ eventBus: bus, getSummary: () => 'summary' });
    useEffect(() => yank(), [yank]);
    return <Text>probe</Text>;
  };
  const r = render(<Probe />);
  return { types: () => published.map((e) => e.type), unmount: r.unmount };
};

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('useYankTask', () => {
  it('publishes banner-clear when unmounted while the toast is up', async () => {
    copy.gate = false;
    const { types, unmount } = mount();
    await tick();
    expect(types()).toEqual(['banner-show']);
    unmount();
    expect(types()).toEqual(['banner-show', 'banner-clear']);
  });

  it('shows nothing when the copy resolves after unmount', async () => {
    copy.gate = true;
    const { types, unmount } = mount();
    await tick();
    unmount();
    copy.release?.();
    await tick();
    expect(types()).toEqual([]);
  });
});
