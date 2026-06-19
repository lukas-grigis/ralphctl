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
 * Pads a number to two digits (zero-fill).
 */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Time-of-day from an ISO timestamp string rendered in the user's LOCAL timezone.
 * `2025-05-16T10:07:42.123Z` → `12:07:42` (UTC+2). Falls back to the raw ISO slice when
 * the string cannot be parsed so a malformed value never throws or renders "NaN".
 */
export const fmtIsoTime = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(11, 19);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/**
 * HH:MM (local timezone) from an ISO timestamp string — minute granularity for banners and
 * resume lines where second precision is visual noise.
 * `2025-05-16T10:07:42.123Z` → `12:07` (UTC+2). Falls back to the raw ISO slice on parse
 * failure.
 */
export const fmtIsoHHMM = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(11, 16);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * Absolute date+time from an ISO timestamp string rendered in the user's LOCAL timezone.
 * `2025-05-16T10:07:42.123Z` → `2025-05-16 12:07` (UTC+2). Falls back to the raw ISO
 * slice on parse failure so a malformed timestamp never throws or renders "NaN".
 */
export const fmtIsoAbsolute = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
