/** `useInput` for prompt components: silent while an overlay owns the keyboard (the prompt is hidden beneath it). */

import { useInput, type Key } from 'ink';
import { useOptionalOverlayState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

export const usePromptInput = (
  handler: (input: string, key: Key) => void,
  options: { readonly isActive?: boolean } = {}
): void => {
  const overlayOpen = useOptionalOverlayState()?.overlayOpen === true;
  useInput(handler, { isActive: !overlayOpen && options.isActive !== false });
};
