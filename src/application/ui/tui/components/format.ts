import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

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

/** Shorten to `max` cells with a trailing `…` (whole code points, so a surrogate pair is never split). */
export const clipWithEllipsis = (text: string, max: number): string => {
  const cps = [...text];
  if (cps.length <= max) return text;
  if (max <= 0) return '';
  return `${cps.slice(0, max - 1).join('')}${glyphs.clipEllipsis}`;
};

/** Shorten `s` to `max` cells by cutting its middle: `/Users/me/…/repo`. */
export const middleTruncate = (s: string, max: number): string => {
  const cps = [...s];
  if (cps.length <= max || max < 3) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${cps.slice(0, head).join('')}${glyphs.clipEllipsis}${cps.slice(cps.length - (keep - head)).join('')}`;
};

/**
 * Fit a line of prose that embeds one absolute path into `max` cells by middle-truncating the path (the only part that
 * is safe to cut), leaving the words around it whole.
 */
export const fitLineWithPath = (line: string, max: number): string => {
  if ([...line].length <= max) return line;
  const match = /(?:~|\/)[^\s`]+/u.exec(line);
  if (match === null) return line;
  const path = match[0];
  const over = [...line].length - max;
  return line.replace(path, middleTruncate(path, Math.max(8, [...path].length - over)));
};
