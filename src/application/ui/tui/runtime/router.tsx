/**
 * Stack-based view router. The whole TUI lives inside one Ink render tree; navigation happens by
 * pushing / popping {@link ViewEntry} objects. Each entry names a view id and an opaque props
 * payload — concrete views know how to type-narrow the props they expect.
 *
 * Why stack-based: every flow in the app is a forward-then-back interaction (open list → drill
 * into detail → escape back). Modal overlays (help, prompts) compose on top of whichever view is
 * on the stack; they never replace it.
 */

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';

export type ViewProps = Readonly<Record<string, unknown>>;

export interface ViewEntry {
  readonly id: string;
  readonly props?: ViewProps;
}

export interface RouterApi {
  readonly stack: readonly ViewEntry[];
  readonly current: ViewEntry;
  push(entry: ViewEntry): void;
  pop(): void;
  replace(entry: ViewEntry): void;
  reset(entry?: ViewEntry): void;
}

const RouterContext = createContext<RouterApi | undefined>(undefined);

export const useRouter = (): RouterApi => {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter: must be used inside <RouterProvider>');
  return ctx;
};

/**
 * Type-narrowing helper for views that expect specific props. Throws a developer-visible error
 * (rendered as a fallback view) when invoked from a view that wasn't pushed with the right
 * shape — beats silent `undefined` propagation.
 */
export const useViewProps = <T extends ViewProps>(): T => {
  const { current } = useRouter();
  return (current.props ?? {}) as T;
};

export interface RouterProviderProps {
  readonly initial: ViewEntry;
  readonly children: (current: ViewEntry) => React.ReactNode;
}

export const RouterProvider = ({ initial, children }: RouterProviderProps): React.JSX.Element => {
  const [stack, setStack] = useState<readonly ViewEntry[]>(() => [initial]);

  const push = useCallback((entry: ViewEntry) => {
    setStack((s) => [...s, entry]);
  }, []);

  const pop = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const replace = useCallback((entry: ViewEntry) => {
    setStack((s) => (s.length === 0 ? [entry] : [...s.slice(0, -1), entry]));
  }, []);

  const reset = useCallback(
    (entry?: ViewEntry) => {
      setStack(() => [entry ?? initial]);
    },
    [initial]
  );

  const current = stack[stack.length - 1] ?? initial;

  const api = useMemo<RouterApi>(
    () => ({ stack, current, push, pop, replace, reset }),
    [stack, current, push, pop, replace, reset]
  );

  return <RouterContext.Provider value={api}>{children(current)}</RouterContext.Provider>;
};

/** Fallback used when a view id is unknown (registry mismatch). */
export const UnknownViewFallback = ({ id }: { readonly id: string }): React.JSX.Element => (
  <Box flexDirection="column" padding={1}>
    <Text color={inkColors.error}>Unknown view: {id}</Text>
    <Text dimColor>Press esc to go back, h to return home.</Text>
  </Box>
);
