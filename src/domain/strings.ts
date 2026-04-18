/**
 * Truncate `str` to at most `max` characters, appending an ellipsis when clipped.
 * The ellipsis counts toward `max` (output length is ≤ `max`).
 */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  if (max <= 1) return '…'.slice(0, Math.max(0, max));
  return str.slice(0, max - 1) + '…';
}
