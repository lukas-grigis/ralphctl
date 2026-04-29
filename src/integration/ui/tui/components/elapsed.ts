/**
 * Format a number of elapsed seconds as a compact human-readable label.
 *
 *   42  → "42s"
 *   125 → "2m 5s"
 *   7320 → "2h 2m"
 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) return `${String(minutes)}m ${String(remSec)}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${String(hours)}h ${String(remMin)}m`;
}
