import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';

/** Below this many rows, chrome spacing is squeezed so Home's menu stays above the fold (measured at 80x24). */
export const SHORT_TERMINAL_ROWS = 40;

export const useShortTerminal = (): boolean => useTerminalSize().rows < SHORT_TERMINAL_ROWS;
