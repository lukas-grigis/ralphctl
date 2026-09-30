const UNITS = ['B', 'KB', 'MB', 'GB'];

export const formatBytes = (n) => {
  let value = n;
  let i = 0;
  while (value >= 1024 && i < UNITS.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${UNITS[i]}`;
};
