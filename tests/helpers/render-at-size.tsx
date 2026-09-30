/**
 * Render an Ink tree at a chosen terminal size. `ink-testing-library` hard-codes 100 columns, so
 * it cannot prove an 80- or 160-column layout; this helper drives Ink's `render()` with a fake
 * stdout whose `columns` / `rows` are caller-controlled and whose `resize()` emits the same
 * `'resize'` event `runtime/use-terminal-size.ts` listens to.
 */

import type React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';

export interface TerminalDims {
  readonly columns: number;
  readonly rows: number;
}

class FakeStdout extends EventEmitter {
  columns: number;
  rows: number;
  readonly isTTY = true;
  readonly frames: string[] = [];
  constructor(dims: TerminalDims) {
    super();
    this.columns = dims.columns;
    this.rows = dims.rows;
  }
  write = (frame: string): void => {
    this.frames.push(frame);
  };
}

/** Stdin shaped like ink-testing-library's: `write` feeds `readable` + `data` listeners. */
class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  private pending: string | null = null;
  write = (data: string): void => {
    this.pending = data;
    this.emit('readable');
    this.emit('data', data);
  };
  read = (): string | null => {
    const d = this.pending;
    this.pending = null;
    return d;
  };
  setEncoding(): void {
    // no-op
  }
  setRawMode(): void {
    // no-op
  }
  resume(): void {
    // no-op
  }
  pause(): void {
    // no-op
  }
  ref(): void {
    // no-op
  }
  unref(): void {
    // no-op
  }
}

export interface RenderAtSizeResult {
  readonly lastFrame: () => string | undefined;
  readonly frames: readonly string[];
  readonly stdin: { readonly write: (data: string) => void };
  readonly rerender: (node: React.ReactNode) => void;
  /** Update the fake terminal size and emit `'resize'`, as a SIGWINCH would. */
  readonly resize: (columns: number, rows: number) => void;
  readonly unmount: () => void;
}

export const renderAtSize = (node: React.ReactNode, dims: TerminalDims): RenderAtSizeResult => {
  const stdout = new FakeStdout(dims);
  const stderr = new FakeStdout(dims);
  const stdin = new FakeStdin();
  const instance = inkRender(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    lastFrame: () => stdout.frames[stdout.frames.length - 1],
    frames: stdout.frames,
    stdin: { write: stdin.write },
    rerender: instance.rerender,
    resize: (columns, rows) => {
      stdout.columns = columns;
      stdout.rows = rows;
      stdout.emit('resize');
    },
    unmount: () => {
      instance.unmount();
      instance.cleanup();
    },
  };
};
