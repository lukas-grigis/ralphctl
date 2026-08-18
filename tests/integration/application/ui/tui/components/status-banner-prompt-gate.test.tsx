/**
 * Regression: `StatusBanner`'s `d` dismiss used to be the one ungated keyboard owner in the
 * chrome. It is mounted inside every `ViewShell`, right next to `PromptHost`, so typing a sprint
 * name / ticket title / refine answer containing the letter `d` silently threw away the topmost
 * banner — including a rate-limit or watchdog warning the operator was meant to act on. The same
 * keystroke also landed while the progress / evaluation / help overlay was up, dismissing banners
 * the operator could not even see.
 *
 * Every other keyboard owner stands down under `ui.modalOpen` (DESIGN-SYSTEM § 4.4); these tests
 * fence that this one does too, without losing the plain `d` dismiss when nothing is claimed.
 */

import React, { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { UiStateProvider, useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { StatusBanner } from '@src/application/ui/tui/components/status-banner.tsx';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

type Bus = ReturnType<typeof createInMemoryEventBus>;

const BANNER_TEXT = 'Rate limit — waiting 30s';

const publishBanner = (bus: Bus): void => {
  bus.publish({ type: 'banner-show', id: 'rate-limit-1', tier: 'warn', message: BANNER_TEXT, at: IsoTimestamp.now() });
};

/** Holds a `claimPrompt()` token for as long as it is mounted — exactly what PromptHost does. */
const ClaimingPrompt = ({ onSubmit }: { readonly onSubmit: (value: string) => void }): React.JSX.Element => {
  const ui = useUiState();
  useEffect(() => ui.claimPrompt(), [ui.claimPrompt]);
  return <TextPrompt message="name" onSubmit={onSubmit} onCancel={() => undefined} />;
};

const Harness = ({
  bus,
  withPrompt,
  onSubmit,
}: {
  readonly bus: Bus;
  readonly withPrompt: boolean;
  readonly onSubmit: (value: string) => void;
}): React.JSX.Element => (
  <DepsProvider value={{ eventBus: bus } as unknown as AppDeps}>
    <UiStateProvider>
      <StatusBanner />
      {withPrompt && <ClaimingPrompt onSubmit={onSubmit} />}
    </UiStateProvider>
  </DepsProvider>
);

describe('StatusBanner — `d` stands down while a prompt owns the keyboard', () => {
  it('keeps the banner and delivers the character when a claimed prompt is up', async () => {
    const bus = createInMemoryEventBus();
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(<Harness bus={bus} withPrompt onSubmit={onSubmit} />);
    await tick(50); // let the claim effect commit

    publishBanner(bus);
    await waitForPredicate(() => (lastFrame() ?? '').includes(BANNER_TEXT));

    // One character per write — a real terminal delivers keystrokes individually, and the
    // ungated handler only matched a bare `d` (a batched 'draft' write arrives as one input
    // string and would have sailed past the bug).
    for (const ch of 'draft') {
      stdin.write(ch);
      await tick();
    }
    stdin.write('\r');
    await tick();

    expect(onSubmit).toHaveBeenCalledWith('draft');
    expect(lastFrame() ?? '').toContain(BANNER_TEXT);
    unmount();
  });

  it('still dismisses on `d` when nothing has claimed the keyboard', async () => {
    const bus = createInMemoryEventBus();
    const { stdin, lastFrame, unmount } = render(<Harness bus={bus} withPrompt={false} onSubmit={() => undefined} />);

    publishBanner(bus);
    await waitForPredicate(() => (lastFrame() ?? '').includes(BANNER_TEXT));

    stdin.write('d');
    await waitForPredicate(() => !(lastFrame() ?? '').includes(BANNER_TEXT));

    expect(lastFrame() ?? '').not.toContain(BANNER_TEXT);
    unmount();
  });
});
