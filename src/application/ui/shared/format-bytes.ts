/** `0 B` / `1.5 KB` / `6.4 MB` — binary units, one decimal from KB up. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${String(Math.max(0, Math.round(bytes)))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
};
