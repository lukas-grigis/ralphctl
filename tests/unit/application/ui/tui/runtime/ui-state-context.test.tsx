/**
 * UiStateProvider unit tests — counter-correctness for the `claimEscape` / `escapeClaimed`
 * pair (the gate that keeps the global `esc → router.pop()` from racing a view-local close
 * handler). Mirrors the existing `claimPrompt` shape; the two counters are independent so
 * `escapeClaimed` does not mute the rest of the global handler.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { UiStateProvider, useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

/**
 * Mounts inside the provider and runs `action(api)` once after a microtask. The deferral
 * matches the pattern in `selection-context.test.tsx` — child useEffect runs before parent
 * useEffect, so calling setters from inside useEffect would otherwise race the provider's
 * own mount work.
 */
const makeTrigger = (
  triggered: { current: boolean },
  action: (api: ReturnType<typeof useUiState>) => void
): (() => React.JSX.Element) => {
  return function Trigger(): React.JSX.Element {
    const api = useUiState();
    const apiRef = React.useRef(api);
    apiRef.current = api;
    React.useEffect(() => {
      if (triggered.current) return;
      triggered.current = true;
      setTimeout(() => {
        action(apiRef.current);
      }, 0);
    }, []);
    return <Text>escapeClaimed={String(api.escapeClaimed)}</Text>;
  };
};

describe('UiStateProvider.claimEscape', () => {
  it('flips escapeClaimed true on first claim, releases back to false when every claim is released', async () => {
    const triggered = { current: false };
    let release1: (() => void) | undefined;
    let release2: (() => void) | undefined;
    const Trigger = makeTrigger(triggered, (api) => {
      release1 = api.claimEscape();
      release2 = api.claimEscape();
    });

    const r = render(
      <UiStateProvider>
        <Trigger />
      </UiStateProvider>
    );

    await new Promise((res) => setTimeout(res, 30));

    // Two claims taken; escapeClaimed should be true.
    expect(r.lastFrame()).toContain('escapeClaimed=true');
    expect(typeof release1).toBe('function');
    expect(typeof release2).toBe('function');

    // Release the first claim — still one outstanding, so the gate stays closed.
    release1!();
    await new Promise((res) => setTimeout(res, 10));
    expect(r.lastFrame()).toContain('escapeClaimed=true');

    // Release the second — counter back to 0, gate opens.
    release2!();
    await new Promise((res) => setTimeout(res, 10));
    expect(r.lastFrame()).toContain('escapeClaimed=false');

    // Idempotent release: calling the same token twice must not push the counter negative.
    release2!();
    await new Promise((res) => setTimeout(res, 10));
    expect(r.lastFrame()).toContain('escapeClaimed=false');

    r.unmount();
  });

  it('keeps escapeClaimed independent from promptActive — both counters live on the same provider', async () => {
    const triggered = { current: false };
    let releaseEscape: (() => void) | undefined;
    const Probe = (): React.JSX.Element => {
      const api = useUiState();
      return (
        <Text>
          esc={String(api.escapeClaimed)} prompt={String(api.promptActive)}
        </Text>
      );
    };
    const Trigger = makeTrigger(triggered, (api) => {
      releaseEscape = api.claimEscape();
    });

    const r = render(
      <UiStateProvider>
        <Probe />
        <Trigger />
      </UiStateProvider>
    );

    await new Promise((res) => setTimeout(res, 30));
    // Claiming escape must not flip promptActive — they are siblings, not aliases.
    expect(r.lastFrame()).toContain('esc=true');
    expect(r.lastFrame()).toContain('prompt=false');

    releaseEscape!();
    await new Promise((res) => setTimeout(res, 10));
    expect(r.lastFrame()).toContain('esc=false');
    expect(r.lastFrame()).toContain('prompt=false');

    r.unmount();
  });
});
