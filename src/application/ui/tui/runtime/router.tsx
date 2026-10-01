/**
 * Sectioned stack router. The whole TUI lives inside one Ink render tree; navigation happens by
 * pushing / popping {@link ViewEntry} objects. Each entry names a view id and an opaque props
 * payload — concrete views know how to type-narrow the props they expect.
 *
 * The app has five persistent sections (Work · Sprints · Projects · Runs · System, see
 * `nav-tree.ts`), and each owns its OWN stack. `push` / `pop` / `replace` / `reset` act on the
 * active section's stack; `goSection` switches between them, restoring the stack the section was
 * left with. That is what makes `esc` mean "up one level in this section" instead of "back through
 * whatever screens I happened to visit", and what lets the location line show where you are.
 *
 * Modal overlays (help, switcher, prompts) compose on top of whichever view is on the stack; they
 * never replace it.
 */

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { sectionDef, sectionOf, type ActiveSection, type SectionId } from '@src/application/ui/tui/runtime/nav-tree.ts';
import type { ViewId } from '@src/application/ui/tui/views/view-registry.tsx';

export type ViewProps = Readonly<Record<string, unknown>>;

export interface ViewEntry {
  readonly id: ViewId;
  readonly props?: ViewProps;
}

export interface RouterApi {
  /** The ACTIVE section's stack. */
  readonly stack: readonly ViewEntry[];
  readonly current: ViewEntry;
  /** The section whose stack is active; `'none'` during the first-run wizard. */
  readonly activeSection: ActiveSection;
  push(entry: ViewEntry): void;
  /**
   * One level up in the active section. At a section root that is not Work it jumps to Work; at
   * the Work root (and in `'none'`) it is a no-op.
   */
  pop(): void;
  replace(entry: ViewEntry): void;
  /**
   * Activate a section, creating `[root]` if it has no stack yet. Re-selecting the section that is
   * already active resets it to its root.
   */
  goSection(id: SectionId): void;
  /**
   * Land on `entry` in ITS section: the section's stack becomes `[root]` when `entry` is the root,
   * else `[root, entry]`. The destination is REQUIRED — an optional "fall back to the launch
   * entry" form used to exist, and both of its callers (`h` = Home, `D` = detach) meant Home. On a
   * first-run session the launch entry is the welcome / create-project wizard, so the bare form
   * silently re-mounted the first-run wizard (which then re-applied its AI preset over the user's
   * Settings edits). Making the parameter required keeps that class of bug unrepresentable.
   */
  reset(entry: ViewEntry): void;
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

type Stacks = Readonly<Record<ActiveSection, readonly ViewEntry[]>>;

interface RouterState {
  readonly active: ActiveSection;
  readonly stacks: Stacks;
}

const EMPTY_STACKS: Stacks = { work: [], sprints: [], projects: [], runs: [], system: [], none: [] };

/**
 * The first-run wizards run outside any section so the tab bar and location line stay hidden;
 * every other launch entry lands in its own section.
 */
const initialSection = (entry: ViewEntry): ActiveSection =>
  entry.id === 'welcome' || entry.id === 'create-project' ? 'none' : sectionOf(entry.id);

const withStack = (state: RouterState, section: ActiveSection, stack: readonly ViewEntry[]): RouterState => ({
  ...state,
  stacks: { ...state.stacks, [section]: stack },
});

const rootEntry = (id: SectionId): ViewEntry => {
  const def = sectionDef(id);
  return { id: def?.rootView ?? 'home' };
};

const activate = (state: RouterState, id: SectionId): RouterState => {
  const existing = state.stacks[id];
  if (state.active === id) return withStack(state, id, [rootEntry(id)]);
  if (existing.length > 0) return { ...state, active: id };
  return { ...withStack(state, id, [rootEntry(id)]), active: id };
};

export const RouterProvider = ({ initial, children }: RouterProviderProps): React.JSX.Element => {
  const [state, setState] = useState<RouterState>(() => {
    const section = initialSection(initial);
    return { active: section, stacks: { ...EMPTY_STACKS, [section]: [initial] } };
  });

  const push = useCallback((entry: ViewEntry) => {
    setState((s) => withStack(s, s.active, [...s.stacks[s.active], entry]));
  }, []);

  const pop = useCallback(() => {
    setState((s) => {
      const stack = s.stacks[s.active];
      if (stack.length > 1) return withStack(s, s.active, stack.slice(0, -1));
      if (s.active !== 'work' && s.active !== 'none') return activate(s, 'work');
      return s;
    });
  }, []);

  const replace = useCallback((entry: ViewEntry) => {
    setState((s) => {
      const stack = s.stacks[s.active];
      return withStack(s, s.active, stack.length === 0 ? [entry] : [...stack.slice(0, -1), entry]);
    });
  }, []);

  const goSection = useCallback((id: SectionId) => {
    setState((s) => activate(s, id));
  }, []);

  const reset = useCallback((entry: ViewEntry) => {
    setState((s) => {
      const section = sectionOf(entry.id);
      if (section === 'none') return { ...withStack(s, 'none', [entry]), active: 'none' };
      const root = rootEntry(section);
      const stack = entry.id === root.id ? [entry] : [root, entry];
      return { ...withStack(s, section, stack), active: section };
    });
  }, []);

  const stack = state.stacks[state.active];
  const current = stack[stack.length - 1] ?? initial;
  const activeSection = state.active;

  const api = useMemo<RouterApi>(
    () => ({ stack, current, activeSection, push, pop, replace, goSection, reset }),
    [stack, current, activeSection, push, pop, replace, goSection, reset]
  );

  return <RouterContext.Provider value={api}>{children(current)}</RouterContext.Provider>;
};

/** Fallback used when a view id is unknown (registry mismatch). */
export const UnknownViewFallback = ({ id }: { readonly id: string }): React.JSX.Element => (
  <Box flexDirection="column" padding={1}>
    <Text color={inkColors.error}>Unknown view: {id}</Text>
    <Text dimColor>Press esc to go back, or 1 for Work.</Text>
  </Box>
);
