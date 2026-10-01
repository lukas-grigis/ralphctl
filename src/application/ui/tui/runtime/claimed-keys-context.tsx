/** Claimed-keys registry — the answer to "who owns this keystroke?". */

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
 * Claim `keys` for as long as the caller is mounted and `enabled`. The effect is keyed on the joined key string, so a
 * fresh array each render does not churn the registry.
 */
export const useClaimKeys = (keys: readonly string[], enabled = true): void => {
  const api = useClaimedKeys();
  const signature = keys.join('\u0000');
  useEffect(() => {
    if (!enabled || signature === '') return undefined;
    return api.claim(signature.split('\u0000'));
  }, [api, signature, enabled]);
};
