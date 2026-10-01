/**
 * View-title channel — `ViewShell` publishes the active view's `title` / `subtitle` / `right` node; the location line
 * (mounted once in `Layout`, above the view) reads them.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export interface ViewTitle {
  readonly title: string;
  readonly subtitle?: string | undefined;
  /**
   * Overrides the last location crumb for views whose name is not their route label (Execute names the flow it is
   * showing).
   */
  readonly crumb?: string | undefined;
  /** Node rendered right after the left text — Execute's status chip. */
  readonly right?: React.ReactNode;
  /** Cells `right` needs, so the location line can budget for it. */
  readonly rightWidth?: number | undefined;
}

type Setter = (next: ViewTitle | undefined) => void;

const ValueContext = createContext<ViewTitle | undefined>(undefined);
const SetterContext = createContext<Setter | undefined>(undefined);

export const ViewTitleProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const [value, setValue] = useState<ViewTitle | undefined>(undefined);
  const set = useCallback<Setter>((next) => {
    setValue((prev) => {
      if (next === undefined) return prev === undefined ? prev : undefined;
      // Bail out when nothing the location line shows changed — `right` is the only field that
      // can differ by identity alone, and an absent one compares equal.
      if (
        prev !== undefined &&
        prev.title === next.title &&
        prev.subtitle === next.subtitle &&
        prev.crumb === next.crumb &&
        prev.rightWidth === next.rightWidth &&
        prev.right === undefined &&
        next.right === undefined
      ) {
        return prev;
      }
      return next;
    });
  }, []);
  const memo = useMemo(() => value, [value]);
  return (
    <SetterContext.Provider value={set}>
      <ValueContext.Provider value={memo}>{children}</ValueContext.Provider>
    </SetterContext.Provider>
  );
};

/** Read side — the location line. */
export const useViewTitle = (): ViewTitle | undefined => useContext(ValueContext);

/** Publish the calling view's title; cleared on unmount. */
export const usePublishViewTitle = (next: ViewTitle): void => {
  const set = useContext(SetterContext);
  useEffect(() => {
    set?.(next);
  });
  useEffect(
    () => () => {
      set?.(undefined);
    },
    [set]
  );
};
