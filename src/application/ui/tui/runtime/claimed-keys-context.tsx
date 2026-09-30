/**
 * Claimed-keys registry — the answer to "who owns this keystroke?".
 *
 * Ink fans every keystroke out to every mounted `useInput`, so a key bound both by the active
 * view and by a global / ambient handler fires twice (`S` detect-skills AND the sprint picker,
 * `d` delete AND banner dismiss). Whoever uses a printable key locally claims it here; the
 * ambient handlers (`useGlobalKeys`, `StatusBanner`, section digits) ask {@link ClaimedKeysApi.isClaimed}
 * before acting and stand down. `useViewKeys` claims its enabled printable bindings automatically;
 * an overlay that uses keys without `useViewKeys` calls {@link useClaimKeys} directly.
 *
 * The registry is a ref (a counter per key), not state: claims are read at keypress time, so
 * registering never re-renders anyone. Both hooks degrade to a no-op without a provider so
 * isolated component tests need no extra wrapper.
 */

import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';

export interface ClaimedKeysApi {
  /** Claim `keys`; returns the matching release. Counter-based, so overlapping claims are safe. */
  claim(keys: readonly string[]): () => void;
  /** `true` while at least one live claim covers `key`. */
  isClaimed(key: string): boolean;
}

const ClaimedKeysContext = createContext<ClaimedKeysApi | undefined>(undefined);

export const ClaimedKeysProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const counts = useRef(new Map<string, number>());
  const api = useMemo<ClaimedKeysApi>(
    () => ({
      claim: (keys) => {
        for (const k of keys) counts.current.set(k, (counts.current.get(k) ?? 0) + 1);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          for (const k of keys) {
            const left = (counts.current.get(k) ?? 0) - 1;
            if (left <= 0) counts.current.delete(k);
            else counts.current.set(k, left);
          }
        };
      },
      isClaimed: (key) => (counts.current.get(key) ?? 0) > 0,
    }),
    []
  );
  return <ClaimedKeysContext.Provider value={api}>{children}</ClaimedKeysContext.Provider>;
};

const NOOP_API: ClaimedKeysApi = { claim: () => () => undefined, isClaimed: () => false };

/** Read side — ambient handlers call `isClaimed(input)` at keypress time. */
export const useClaimedKeys = (): ClaimedKeysApi => useContext(ClaimedKeysContext) ?? NOOP_API;

/**
 * Claim `keys` for as long as the caller is mounted and `enabled`. The effect is keyed on the
 * joined key string, so a fresh array each render does not churn the registry.
 */
export const useClaimKeys = (keys: readonly string[], enabled = true): void => {
  const api = useClaimedKeys();
  const signature = keys.join('\u0000');
  useEffect(() => {
    if (!enabled || signature === '') return undefined;
    return api.claim(signature.split('\u0000'));
  }, [api, signature, enabled]);
};
