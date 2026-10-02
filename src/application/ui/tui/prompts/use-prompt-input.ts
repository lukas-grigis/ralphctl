/** `useInput` for prompt components: silent while any overlay owns the keyboard (the view and its prompt are hidden then). */

import { useInput, type Key } from 'ink';
import { useOptionalOverlayState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

export const usePromptInput = (
  handler: (input: string, key: Key) => void,
  options: { readonly isActive?: boolean } = {}
): void => {
  const overlayOpen = useOptionalOverlayState()?.overlay !== undefined;
  useInput(handler, { isActive: !overlayOpen && options.isActive !== false });
};
