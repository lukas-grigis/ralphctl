/**
 * `useViewKeys` — one declaration of "what local keys mean on this screen", feeding BOTH the `useInput` dispatcher
 * and the status-bar hint strip from the same array.
 */

import { useEffect, useRef } from 'react';
import { useInput, type Key } from 'ink';
import { useViewHints, type ViewHint } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useClaimKeys } from '@src/application/ui/tui/runtime/claimed-keys-context.tsx';
import { useOptionalOverlayState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { isChord } from '@src/application/ui/tui/runtime/key-chord.ts';

export interface ViewKeyBinding {
  /**
   * Literal `input` strings this binding claims. Doubles as the status-bar spelling once joined by `/` — `['↑', '↓',
   * 'j', 'k']` renders as `↑/↓/j/k`.
   */
  readonly keys: readonly string[];
  /** Status-bar action label — reuse the DESIGN-SYSTEM §6.3 vocabulary (`move`, `open`, …). */
  readonly hint: string;
  /** `false` mutes the handler and drops the hint. Omitted means enabled. */
  readonly enabled?: boolean;
  /** Drops the hint while keeping the handler live. Omitted means shown. */
  readonly hidden?: boolean;
  /** Omit for a documentation-only entry describing a key another primitive owns. */
  readonly run?: (input: string, key: Key) => void;
  /** Omitted means the bare key only — Ink reports ctrl+c as input `c`. */
  readonly chord?: 'ctrl' | 'meta';
}

export interface UseViewKeysOptions {
  /**
   * Mutes the dispatcher while `false` — the view-wide keyboard yield for a mounted modal / confirm overlay. Defaults
   * to `true`.
   */
  readonly active?: boolean;
}

const SPECIAL_KEYS: Readonly<Record<string, (key: Key) => boolean>> = {
  '↵': (key) => key.return,
  esc: (key) => key.escape,
  Tab: (key) => key.tab,
  '↑': (key) => key.upArrow,
  '↓': (key) => key.downArrow,
  '←': (key) => key.leftArrow,
  '→': (key) => key.rightArrow,
  Home: (key) => key.home,
  End: (key) => key.end,
  PgUp: (key) => key.pageUp,
  PgDn: (key) => key.pageDown,
};

const chordMatches = (chord: ViewKeyBinding['chord'], key: Key): boolean => {
  if (chord === undefined) return !isChord(key);
  return chord === 'ctrl' ? key.ctrl : key.meta && !key.ctrl;
};

const matches = (binding: ViewKeyBinding, token: string, input: string, key: Key): boolean => {
  const special = SPECIAL_KEYS[token];
  if (special !== undefined) return special(key);
  return (token === 'space' ? ' ' : token) === input && chordMatches(binding.chord, key);
};

/** Printable single characters are claimable; arrows, `↵`, `esc` and named keys are not. */
const PRINTABLE = /^[ -~]$/u;

const toHint = (binding: ViewKeyBinding): ViewHint => ({
  keys: binding.keys.map((k) => (binding.chord === undefined ? k : `${binding.chord}+${k}`)).join('/'),
  label: binding.hint,
  ...(binding.enabled !== undefined ? { enabledWhen: binding.enabled } : {}),
});

/**
 * How long after mount a key may wait for its binding to become enabled — covers a view whose data is still loading
 * when the operator types ahead after a section switch.
 */
const TYPE_AHEAD_MS = 1500;
const TYPE_AHEAD_MAX = 4;

interface PendingKey {
  readonly input: string;
  readonly key: Key;
}

const findEnabled = (bindings: readonly ViewKeyBinding[], input: string, key: Key): ViewKeyBinding | undefined =>
  bindings.find(
    (b) => b.run !== undefined && b.enabled !== false && b.keys.some((token) => matches(b, token, input, key))
  );

export const useViewKeys = (bindings: readonly ViewKeyBinding[], options: UseViewKeysOptions = {}): void => {
  const modalOpen = useOptionalOverlayState()?.modalOpen === true;
  const active = (options.active ?? true) && !modalOpen;

  const mountedAt = useRef(Date.now());
  const pending = useRef<PendingKey[]>([]);

  useInput(
    (input, key) => {
      const binding = findEnabled(bindings, input, key);
      if (binding?.run !== undefined) {
        binding.run(input, key);
        return;
      }
      // Gated off right after mount (data still loading): hold the key until its binding enables.
      const gated = bindings.some(
        (b) => b.run !== undefined && b.enabled === false && b.keys.some((token) => matches(b, token, input, key))
      );
      if (gated && Date.now() - mountedAt.current < TYPE_AHEAD_MS && pending.current.length < TYPE_AHEAD_MAX) {
        pending.current.push({ input, key });
      }
    },
    { isActive: active }
  );

  // Every render: a loaded view re-renders, which is when a held key's gate may have opened.
  useEffect(() => {
    if (pending.current.length === 0) return;
    const held = pending.current;
    if (!active || Date.now() - mountedAt.current >= TYPE_AHEAD_MS) {
      pending.current = [];
      return;
    }
    pending.current = held.filter((p) => {
      const binding = findEnabled(bindings, p.input, p.key);
      if (binding?.run === undefined) return true;
      binding.run(p.input, p.key);
      return false;
    });
  });

  const claimed = bindings
    .filter((b) => b.run !== undefined && b.enabled !== false && b.chord === undefined)
    .flatMap((b) => b.keys.filter((k) => PRINTABLE.test(k)));
  useClaimKeys(claimed, active);

  // A fresh array every render is fine — `useViewHints` bails out on equal content, so this only
  // reaches the registry when a label or a gate actually changed.
  useViewHints(bindings.filter((b) => b.hidden !== true).map(toHint));
};
