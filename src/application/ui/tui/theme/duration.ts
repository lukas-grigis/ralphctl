/**
 * Human-readable duration formatter used across the TUI. Sub-second values render as whole
 * milliseconds (e.g. `9ms`) — the chain timer reports floats with a long fractional tail and
 * those extra digits are visual noise next to the actual numbers we care about. Above one
 * second we switch to `X.Ys`; above a minute, `MmSs`.
 */
export const fmtDuration = (ms: number): string => {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${String(m)}m${String(s)}s`;
};

/**
 * Wall-clock elapsed between two epoch-ms timestamps, padded for stable column alignment in
 * status bars / session lists (`5m30s` not `5m3s`). Pass `Date.now()` as `end` for ongoing
 * sessions. Differs from {@link fmtDuration} only in the sub-second/minute formatting choices.
 */
export const fmtElapsed = (startedAt: number, end: number): string => {
  const ms = end - startedAt;
  if (ms < 1000) return `${String(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  return `${String(m)}m${String(s % 60).padStart(2, '0')}s`;
};

/**
 * Time-of-day slice from an ISO timestamp string. `2025-05-16T17:07:42.123Z` → `17:07:42`.
 * Pure string slicing — never goes through `Date` to avoid timezone surprises and per-call
 * `Date` allocation on hot render paths (the log tail formats a row per log entry per render).
 */
export const fmtIsoTime = (iso: string): string => iso.slice(11, 19);

/**
 * Absolute date+time slice from an ISO timestamp string for the sprint header.
 * `2025-05-16T17:07:42.123Z` → `2025-05-16 17:07`. Same rationale as {@link fmtIsoTime} —
 * we never need second precision in header chrome and we want to avoid `Date` allocation.
 */
export const fmtIsoAbsolute = (iso: string): string => iso.slice(0, 16).replace('T', ' ');
