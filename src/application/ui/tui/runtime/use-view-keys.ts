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
 * The optional `active` flag mutes the whole dispatcher — the view-wide equivalent of Ink's own
 * `isActive`, for when a modal / confirm overlay owns the keyboard. Hints are untouched by it:
 * the strip keeps describing the screen underneath the overlay, exactly as it did before.
 */

import { useInput, type Key } from 'ink';
import { useViewHints, type ViewHint } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

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

const toHint = (binding: ViewKeyBinding): ViewHint => ({
  keys: binding.keys.join('/'),
  label: binding.hint,
  ...(binding.enabled !== undefined ? { enabledWhen: binding.enabled } : {}),
});

export const useViewKeys = (bindings: readonly ViewKeyBinding[], options: UseViewKeysOptions = {}): void => {
  const active = options.active ?? true;

  useInput(
    (input, key) => {
      for (const binding of bindings) {
        if (binding.run === undefined || binding.enabled === false) continue;
        if (!binding.keys.includes(input)) continue;
        binding.run(input, key);
        return;
      }
    },
    { isActive: active }
  );

  // A fresh array every render is fine — `useViewHints` bails out on equal content, so this only
  // reaches the registry when a label or a gate actually changed.
  useViewHints(bindings.filter((b) => b.hidden !== true).map(toHint));
};
