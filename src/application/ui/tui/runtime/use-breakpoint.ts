/**
 * Responsive breakpoint hook for TUI views. Thin wrapper over {@link useTerminalSize} that
 * resolves the active {@link Breakpoint} per the rules in `theme/tokens.ts`. Views that only
 * need the breakpoint discriminator (not the raw column count) use this hook to stay aligned
 * with the rest of the design system.
 *
 * The hook re-derives on every SIGWINCH (resize) via the underlying terminal-size subscription,
 * so layouts react cleanly as the user resizes mid-flight.
 */

import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { breakpointFor, type Breakpoint } from '@src/application/ui/tui/theme/tokens.ts';

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
