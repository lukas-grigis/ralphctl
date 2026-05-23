/**
 * `useNoColor` — read the `NO_COLOR` environment variable as a boolean. Truthy when set to any
 * non-empty value (per <https://no-color.org/>: "When present, regardless of its value,
 * prevents the addition of ANSI color"). Components that have both a colour and a shape
 * encoding read this to swap glyphs in when colour is unavailable.
 *
 * The check is intentionally a hook (not a top-level const) so future surfaces can use a React
 * context override for design previews / tests without changing the consumer call sites.
 *
 * The value is read once on mount and cached — `NO_COLOR` doesn't change at runtime in any
 * deployment we care about (an env var flip would require a restart), and re-reading
 * `process.env` per render has measurable overhead in deeply-nested Ink trees.
 */

import { useMemo } from 'react';

/** @public */
export const useNoColor = (): boolean => useMemo(() => Boolean(process.env['NO_COLOR']), []);
