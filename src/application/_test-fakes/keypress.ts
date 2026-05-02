/**
 * `keypress` — typed wrappers over `stdin.write()` that resolve through
 * `keyboard-map.ts`. Tests describe intent (`press(stdin, 'global.back')`)
 * instead of byte sequences (`stdin.write('\x1B')`), and a binding rename
 * propagates automatically.
 *
 * The keyboard map stores **documentary** key names (`'esc'`, `'enter'`,
 * `'↑'`, `'PgUp'`, `'tab'`) — Ink's `useInput` consumes these via
 * `(input, key)` flags rather than raw bytes. This module owns the
 * translation table from documentary names to the byte sequences that
 * the Ink renderer's stdin actually expects.
 *
 * Unmapped names fall through as-is — that's correct for plain letters
 * (`'b'`, `'q'`, `'?'`).
 */
import type { Writable } from 'node:stream';
import { type Action, getKeyFor } from '@src/application/tui/keyboard-map.ts';

const KEY_BYTES: Readonly<Record<string, string>> = {
  esc: '\x1B',
  enter: '\r',
  tab: '\t',
  'shift+tab': '\x1B[Z',
  '↑': '\x1B[A',
  '↓': '\x1B[B',
  '←': '\x1B[D',
  '→': '\x1B[C',
  PgUp: '\x1B[5~',
  PgDn: '\x1B[6~',
  backspace: '\x7F',
  delete: '\x1B[3~',
  space: ' ',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+a': '\x01',
  'ctrl+e': '\x05',
};

/**
 * Translate a documentary key name (`'esc'`, `'↑'`, `'tab'`, `'b'`, …)
 * into the byte sequence Ink's stdin handler reads. Multi-character
 * names that aren't in the table fall through verbatim — single chars
 * get the same treatment, so `keyToBytes('b') === 'b'`.
 */
export function keyToBytes(key: string): string {
  return KEY_BYTES[key] ?? key;
}

/** Stdin shape exposed by ink-testing-library's `render()`. */
export interface TestStdin {
  write(data: string): void;
}

/**
 * Press the canonical key bound to `action` on `stdin`. Looks up the
 * binding via {@link getKeyFor} and writes the byte sequence. Stops
 * tests from drifting from the keyboard map.
 */
export function press(stdin: TestStdin | Writable, action: Action): void {
  const key = getKeyFor(action);
  stdin.write(keyToBytes(key));
}

/** Convenience: press a sequence of actions in order. */
export function presses(stdin: TestStdin | Writable, actions: readonly Action[]): void {
  for (const action of actions) press(stdin, action);
}

/**
 * Type plain text into the focused input. Multi-character pastes and
 * ASCII text just go through `stdin.write` unchanged.
 */
export function type(stdin: TestStdin | Writable, text: string): void {
  stdin.write(text);
}

/**
 * Press a single documentary key by name. Useful for keys that aren't
 * mapped to any keyboard-map action (e.g. `'b'`, `'?'`, the home-only
 * browse key when the binding hasn't been declared yet, etc.).
 */
export function pressKey(stdin: TestStdin | Writable, key: string): void {
  stdin.write(keyToBytes(key));
}
