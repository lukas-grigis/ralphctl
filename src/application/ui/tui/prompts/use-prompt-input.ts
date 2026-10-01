/** `useInput` for prompt components: silent while the quit confirm owns the keyboard, so its `y` never answers one. */

import { useInput, type Key } from 'ink';
import { useOptionalOverlayState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

export const usePromptInput = (
  handler: (input: string, key: Key) => void,
  options: { readonly isActive?: boolean } = {}
): void => {
  const quitOpen = useOptionalOverlayState()?.overlay?.kind === 'quit';
  useInput(handler, { isActive: !quitOpen && options.isActive !== false });
};
