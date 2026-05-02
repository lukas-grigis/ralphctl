/**
 * `useViewInput` — drop-in replacement for Ink's `useInput` that
 * automatically suspends the handler while a prompt owns the keyboard.
 *
 * Why this exists: every view that owned its own `useInput` had to
 * remember to pass `{ isActive: currentPrompt === null }` and import
 * `useCurrentPrompt`. Skipping the guard meant typing a letter that
 * happens to match a view shortcut (e.g. `c` while editing a script
 * value, `b` inside a description) would fire BOTH the prompt's input
 * handler AND the view's keyboard shortcut. Bugs were filed for the
 * onboarding flow ("typing 'c' in the setup script triggered a Cancel
 * Run prompt"); this hook eliminates that whole class of bug.
 *
 * Behaviour matches `useInput` exactly when no prompt is active. While
 * a prompt is active, the handler is fully inactive — it does not fire
 * for any keystroke.
 *
 * Drop-in: `useInput(handler, opts)` → `useViewInput(handler, opts)`.
 * If the caller passes its own `isActive`, it is AND-ed with the
 * prompt-active check (an explicit `false` still wins).
 */

import { useInput } from 'ink';
import { useCurrentPrompt } from '@src/integration/ui/prompts/hooks.ts';

type Handler = Parameters<typeof useInput>[0];
type Options = NonNullable<Parameters<typeof useInput>[1]>;

export function useViewInput(handler: Handler, options: Options = {}): void {
  const currentPrompt = useCurrentPrompt();
  const callerActive = options.isActive ?? true;
  const isActive = callerActive && currentPrompt === null;
  useInput(handler, { ...options, isActive });
}
