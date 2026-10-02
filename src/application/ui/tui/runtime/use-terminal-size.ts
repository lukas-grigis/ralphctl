/**
 * Terminal size + resize handling. Ink exposes columns/rows on `useStdout`; this hook listens
 * to SIGWINCH so views relayout cleanly when the user resizes the terminal mid-flight.
 */

import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

const readSize = (stdout: NodeJS.WriteStream | undefined): TerminalSize => ({
  columns: stdout?.columns ?? 80,
  rows: stdout?.rows ?? 24,
});

export const useTerminalSize = (): TerminalSize => {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));

  useEffect(() => {
    if (!stdout) return undefined;
    const onResize = (): void => {
      setSize(readSize(stdout));
    };
    stdout.on('resize', onResize);
    onResize();
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
};
