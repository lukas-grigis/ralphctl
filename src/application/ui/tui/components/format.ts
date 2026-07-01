/**
 * Compact a token count for display: `200000` → `200k`, `12400` → `12.4k`, `1500` → `1.5k`,
 * `120` → `120`, `1000000` → `1M`, `1200000` → `1.2M`. Token counts in the TUI can run large
 * (context windows trend 200k–1M) and the surfaces that render them are narrow columns; values
 * ≥ 1M use an `M` suffix so a 1M context window renders as `1M`, not `1000k`. Shared by the
 * token-budget card and the tasks-panel formatters so both surfaces agree on the same
 * compaction rules.
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
