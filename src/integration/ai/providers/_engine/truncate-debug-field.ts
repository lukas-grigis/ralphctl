/**
 * Truncate a free-form string for inclusion in a debug-level `LogEvent.meta` payload.
 *
 * The headless provider adapters (`claude/`, `copilot/`, `codex/`) publish one debug event per
 * recognised stream line so operators can `tail -f` chain.log under `RALPHCTL_DEBUG_TRACE=1`
 * without drowning in untruncated JSON. Stream payloads are unbounded by design — a single
 * assistant turn can carry several KB of text, and tool inputs (e.g. file diffs) can be larger
 * still — so every field that originated from the AI stream is funnelled through this helper.
 *
 * Semantics:
 *  - `undefined` / empty / whitespace-only input → `undefined` (caller omits the key entirely
 *    via the `...(v !== undefined ? { k: v } : {})` spread pattern used across the adapters).
 *  - Strings at or below `max` length pass through verbatim.
 *  - Strings over `max` length are sliced to `max` and appended with `'…'` (one Unicode code
 *    point, not three ASCII dots) so the truncation is visually obvious in chain.log.
 *
 * `max` defaults to 120 — long enough to recognise a tool name + a short argument preview at a
 * glance, short enough that ten debug lines per turn stay under a single screen.
 */
export const truncateField = (value: string | undefined, max = 120): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (value.length === 0) return undefined;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
};
