/**
 * Compact a token count for display: `200000` → `200k`, `12400` → `12.4k`, `1500` → `1.5k`, `120` → `120`, `1000000`
 * → `1M`, `1200000` → `1.2M`.
 */
export const fmtTokens = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return String(Math.round(n));
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  const k = n / 1000;
  return k >= 100 ? `${String(Math.round(k))}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
};
