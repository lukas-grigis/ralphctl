/** Cursor helpers shared by the choice prompts: disabled rows are never a cursor stop. */

import type { Choice } from '@src/business/interactive/prompt.ts';

export const isEnabled = (opt: Choice<unknown> | undefined): boolean => opt !== undefined && opt.disabled !== true;

/** Walk from `from` (exclusive) in `direction` (-1 or +1) and return the first enabled index (or `from`). */
export const nextEnabledIndex = (options: ReadonlyArray<Choice<unknown>>, from: number, direction: -1 | 1): number => {
  for (let i = from + direction; i >= 0 && i < options.length; i += direction) {
    if (isEnabled(options[i])) return i;
  }
  return from;
};

export const firstEnabledIndex = (options: ReadonlyArray<Choice<unknown>>): number => {
  for (let i = 0; i < options.length; i += 1) {
    if (isEnabled(options[i])) return i;
  }
  return 0;
};

export const lastEnabledIndex = (options: ReadonlyArray<Choice<unknown>>): number => {
  for (let i = options.length - 1; i >= 0; i -= 1) {
    if (isEnabled(options[i])) return i;
  }
  return Math.max(0, options.length - 1);
};
