/**
 * Verify the declarative `enabledWhen` gate on view hints (audit theme 1 foundation):
 *  - a hint with `enabledWhen: false` is omitted from the merged active set,
 *  - `undefined` / `true` still pass (backward-compatible with existing callers),
 *  - toggling `false → true` makes the hint appear,
 *  - the `hintsEqual` short-circuit helper compares `enabledWhen` so a toggle re-renders.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import {
  HintsProvider,
  hintsEqual,
  useActiveHints,
  useViewHints,
  type ViewHint,
} from '@src/application/ui/tui/runtime/use-view-hints.tsx';

const flush = async (): Promise<void> => {
  await new Promise((res) => setTimeout(res, 5));
};

const Publisher = ({ hints }: { readonly hints: readonly ViewHint[] }): React.JSX.Element => {
  useViewHints(hints);
  return <Text>publisher</Text>;
};

const Reader = ({ onState }: { readonly onState: (hints: readonly ViewHint[]) => void }): React.JSX.Element => {
  const active = useActiveHints();
  onState(active);
  return <Text>reader</Text>;
};

const Tree = ({
  hints,
  onState,
}: {
  readonly hints: readonly ViewHint[];
  readonly onState: (hints: readonly ViewHint[]) => void;
}): React.JSX.Element => (
  <HintsProvider>
    <Publisher hints={hints} />
    <Reader onState={onState} />
  </HintsProvider>
);

describe('useViewHints enabledWhen gate', () => {
  it('omits a hint with enabledWhen:false while keeping undefined / true entries', async () => {
    let last: readonly ViewHint[] = [];
    const hints: readonly ViewHint[] = [
      { keys: '↑/↓', label: 'move' },
      { keys: 'e', label: 'edit', enabledWhen: false },
      { keys: 'd', label: 'delete', enabledWhen: true },
    ];
    const r = render(<Tree hints={hints} onState={(h) => (last = h)} />);
    await flush();

    expect(last.map((h) => h.keys)).toEqual(['↑/↓', 'd']);
    expect(last.some((h) => h.keys === 'e')).toBe(false);
    r.unmount();
  });

  it('reveals the hint when enabledWhen toggles false → true', async () => {
    let last: readonly ViewHint[] = [];
    const disabled: readonly ViewHint[] = [{ keys: 'e', label: 'edit', enabledWhen: false }];
    const r = render(<Tree hints={disabled} onState={(h) => (last = h)} />);
    await flush();
    expect(last.some((h) => h.keys === 'e')).toBe(false);

    const enabled: readonly ViewHint[] = [{ keys: 'e', label: 'edit', enabledWhen: true }];
    r.rerender(<Tree hints={enabled} onState={(h) => (last = h)} />);
    await flush();

    expect(last.map((h) => h.keys)).toEqual(['e']);
    r.unmount();
  });
});

describe('hintsEqual', () => {
  it('returns false when only enabledWhen changes', () => {
    const a: readonly ViewHint[] = [{ keys: 'e', label: 'edit', enabledWhen: false }];
    const b: readonly ViewHint[] = [{ keys: 'e', label: 'edit', enabledWhen: true }];
    expect(hintsEqual(a, b)).toBe(false);
  });

  it('treats undefined and true as distinct so the gate flip re-renders', () => {
    const a: readonly ViewHint[] = [{ keys: 'e', label: 'edit' }];
    const b: readonly ViewHint[] = [{ keys: 'e', label: 'edit', enabledWhen: true }];
    expect(hintsEqual(a, b)).toBe(false);
  });

  it('returns true when keys, label, and enabledWhen all match', () => {
    const a: readonly ViewHint[] = [{ keys: 'e', label: 'edit', enabledWhen: false }];
    const b: readonly ViewHint[] = [{ keys: 'e', label: 'edit', enabledWhen: false }];
    expect(hintsEqual(a, b)).toBe(true);
  });
});
