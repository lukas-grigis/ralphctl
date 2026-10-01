/** Shared mount-guard ref: `true` while the owning component is mounted, flipped to `false` on unmount. */

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
