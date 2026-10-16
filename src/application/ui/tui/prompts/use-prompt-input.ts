/** `useInput` / `usePaste` for prompt components: silent while an overlay owns the keyboard (the prompt is hidden beneath it). */

import { useInput, usePaste, type Key } from 'ink';
import { useOptionalOverlayState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

const usePromptActive = (options: { readonly isActive?: boolean }): boolean => {
  const overlayOpen = useOptionalOverlayState()?.overlayOpen === true;
  return !overlayOpen && options.isActive !== false;
};

export const usePromptInput = (
  handler: (input: string, key: Key) => void,
  options: { readonly isActive?: boolean } = {}
): void => {
  useInput(handler, { isActive: usePromptActive(options) });
};

/** Bracketed paste via Ink: it owns DEC mode 2004, so the mode is switched off on every unmount path. */
export const usePromptPaste = (
  handler: (text: string) => void,
  options: { readonly isActive?: boolean } = {}
): void => {
  usePaste(handler, { isActive: usePromptActive(options) });
};
