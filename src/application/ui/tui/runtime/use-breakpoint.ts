/**
 * Responsive breakpoint hook for TUI views. Thin wrapper over {@link useTerminalSize} that resolves the active {@link
 * Breakpoint} per the rules in `theme/tokens.ts`.
 * @public
 */

import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { type Breakpoint, breakpointFor } from '@src/application/ui/tui/theme/tokens.ts';

/** @public */
export interface BreakpointState {
  readonly breakpoint: Breakpoint;
  readonly columns: number;
  readonly rows: number;
  /** True when `breakpoint` is at least the given threshold. */
  readonly atLeast: (target: Breakpoint) => boolean;
}

const ORDER: readonly Breakpoint[] = ['sm', 'md', 'lg', 'xl', 'xxl'];

export const useBreakpoint = (): BreakpointState => {
  const size = useTerminalSize();
  const breakpoint = breakpointFor(size.columns);
  const atLeast = (target: Breakpoint): boolean => ORDER.indexOf(breakpoint) >= ORDER.indexOf(target);
  return { breakpoint, columns: size.columns, rows: size.rows, atLeast };
};
