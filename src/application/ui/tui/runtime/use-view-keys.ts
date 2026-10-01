/**
 * `useViewKeys` — one declaration of "what local keys mean on this screen", feeding BOTH the `useInput` dispatcher
 * and the status-bar hint strip from the same array.
 */

import { useInput, type Key } from 'ink';
import { useViewHints, type ViewHint } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useClaimKeys } from '@src/application/ui/tui/runtime/claimed-keys-context.tsx';
import { useOptionalOverlayState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

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

const matches = (token: string, input: string, key: Key): boolean => {
  if (token === 'space') return input === ' ';
  const special = SPECIAL_KEYS[token];
  return special !== undefined ? special(key) : token === input;
};

/** Printable single characters are claimable; arrows, `↵`, `esc` and named keys are not. */
const PRINTABLE = /^[ -~]$/u;

const toHint = (binding: ViewKeyBinding): ViewHint => ({
  keys: binding.keys.join('/'),
  label: binding.hint,
  ...(binding.enabled !== undefined ? { enabledWhen: binding.enabled } : {}),
});

export const useViewKeys = (bindings: readonly ViewKeyBinding[], options: UseViewKeysOptions = {}): void => {
  const modalOpen = useOptionalOverlayState()?.modalOpen === true;
  const active = (options.active ?? true) && !modalOpen;

  useInput(
    (input, key) => {
      for (const binding of bindings) {
        if (binding.run === undefined || binding.enabled === false) continue;
        if (!binding.keys.some((token) => matches(token, input, key))) continue;
        binding.run(input, key);
        return;
      }
    },
    { isActive: active }
  );

  const claimed = bindings
    .filter((b) => b.run !== undefined && b.enabled !== false)
    .flatMap((b) => b.keys.filter((k) => PRINTABLE.test(k)));
  useClaimKeys(claimed, active);

  // A fresh array every render is fine — `useViewHints` bails out on equal content, so this only
  // reaches the registry when a label or a gate actually changed.
  useViewHints(bindings.filter((b) => b.hidden !== true).map(toHint));
};
