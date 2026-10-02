/**
 * Shared mount-guard ref: `true` while the owning component is mounted, flipped to `false` on
 * unmount. Callers gate post-await state writes on `mountedRef.current` so an async handler that
 * resolves after the view unmounted doesn't fire `setState` into a dead tree.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

export const useIsMounted = (): RefObject<boolean> => {
  const ref = useRef(true);
  useEffect(
    () => () => {
      ref.current = false;
    },
    []
  );
  return ref;
};
