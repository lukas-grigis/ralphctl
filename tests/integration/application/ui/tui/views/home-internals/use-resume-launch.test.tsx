/** Stale run records are superseded only once the resume actually started — a refused launch keeps them. */

import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { useResumeLaunch } from '@src/application/ui/tui/views/home-internals/use-resume-launch.ts';

const launchRef = vi.hoisted(() => ({ launch: vi.fn<(flowId: string) => Promise<boolean>>() }));
vi.mock('@src/application/ui/tui/runtime/use-flow-launcher.ts', () => ({
  useFlowLauncher: () => ({ launch: launchRef.launch, launchability: () => ({ ok: true }), launchError: undefined }),
}));

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

const mount = (dismissStale: () => Promise<void>): { readonly resume: () => void; readonly unmount: () => void } => {
  let api: ReturnType<typeof useResumeLaunch> | undefined;
  const Probe = (): React.JSX.Element => {
    api = useResumeLaunch(undefined, () => undefined, dismissStale);
    return <Text>probe</Text>;
  };
  const r = render(<Probe />);
  return { resume: () => api?.resume(), unmount: r.unmount };
};

describe('useResumeLaunch', () => {
  it('launches implement and then dismisses the stale records', async () => {
    launchRef.launch.mockResolvedValue(true);
    const dismissStale = vi.fn(() => Promise.resolve());
    const { resume, unmount } = mount(dismissStale);
    resume();
    await tick();
    expect(launchRef.launch).toHaveBeenCalledWith('implement');
    expect(dismissStale).toHaveBeenCalledOnce();
    unmount();
  });

  it('keeps the records when the launch was cancelled or refused', async () => {
    launchRef.launch.mockResolvedValue(false);
    const dismissStale = vi.fn(() => Promise.resolve());
    const { resume, unmount } = mount(dismissStale);
    resume();
    await tick();
    expect(dismissStale).not.toHaveBeenCalled();
    unmount();
  });
});
