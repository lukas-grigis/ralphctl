/**
 * `useViewKeys` — one declaration of "what local keys mean on this screen", feeding BOTH the
 * `useInput` dispatcher and the status-bar hint strip from the same array.
 *
 * Views used to declare their keys twice: once as a `useViewHints([...])` array and once as a
 * chain of `if (input === 'x')` branches. The two drifted — a key could be advertised as live
 * while its handler rejected it (or vice versa), and any gate that mattered to both had to be
 * written out twice. Here a binding carries its own gate, so the hint and the handler cannot
 * disagree by construction.
 *
 * Binding fields:
 *
 *   - `keys` — the literal `input` strings this binding claims, and (joined by `/`) its
 *     status-bar spelling. An entry with no `run` is documentation only: it advertises a key the
 *     windowed-list primitive already owns (`↑/↓`, `↵`) without claiming it.
 *   - `enabled` — `false` mutes the handler AND drops the hint. Use it when the key genuinely
 *     does nothing in the current state, so the strip never advertises a dead key.
 *   - `hidden` — drops the hint while leaving the handler live. Use it when the key IS inert but
 *     the handler exists to say why (someone who found it in the `?` overlay still presses it,
 *     and a silent swallow reads as a bug).
 *
 * Special keys are spelled as their hint glyphs: `↵` (return), `esc`, `Tab`, `↑`, `↓`, `←`, `→`, `PgUp`,
 * `PgDn`, `Home`, `End`. Every other entry matches the literal `input` string.
 *
 * The optional `active` flag mutes the whole dispatcher — the view-wide equivalent of Ink's own
 * `isActive`, for when a confirm overlay owns the keyboard. The dispatcher also mutes itself
 * while any app-level overlay (help / progress / evaluation) is open, so a view kept mounted
 * under `display: none` never sees those keystrokes. Hints are untouched by both: the strip keeps
 * describing the screen underneath the overlay.
 *
 * Keyboard ownership: while the dispatcher is live, every enabled binding that has a `run` and a
 * printable single-character key CLAIMS that key in the claimed-keys registry. `useGlobalKeys`
 * and `StatusBanner` skip claimed keys, so a key a view uses never also fires a global action.
 */

import { useInput, type Key } from 'ink';
import { useViewHints, type ViewHint } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useClaimKeys } from '@src/application/ui/tui/runtime/claimed-keys-context.tsx';
import { useOptionalOverlayState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

export interface ViewKeyBinding {
  /**
   * Literal `input` strings this binding claims. Doubles as the status-bar spelling once joined
   * by `/` — `['↑', '↓', 'j', 'k']` renders as `↑/↓/j/k`.
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
   * Mutes the dispatcher while `false` — the view-wide keyboard yield for a mounted modal /
   * confirm overlay. Defaults to `true`. Hints are published regardless.
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
  const overlayOpen = useOptionalOverlayState()?.overlay !== undefined;
  const active = (options.active ?? true) && !overlayOpen;

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
