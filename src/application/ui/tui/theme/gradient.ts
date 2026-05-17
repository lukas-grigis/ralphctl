/**
 * Tiny inline gradient renderer — replaces v1's `gradient-string` dependency.
 *
 * Produces ANSI 24-bit truecolor escape sequences (`\x1b[38;2;R;G;Bm`) that Ink's `<Text>`
 * passes through unchanged. Each glyph in a line gets its own colour interpolated across the
 * stops in HSV space (with shortest-path hue rotation), so wide ASCII art reads as a smooth
 * sweep instead of stripes.
 */

const RESET = '\x1b[0m';

const ansi = (r: number, g: number, b: number): string => `\x1b[38;2;${String(r)};${String(g)};${String(b)}m`;

/** `#RRGGBB` → `[r,g,b]` (0-255). Throws on malformed input — stops are author-controlled. */
const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([\da-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`gradient: invalid hex '${hex}'`);
  const n = Number.parseInt(m[1] ?? '', 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

/** RGB (0-255) → HSV (h ∈ [0,360), s ∈ [0,1], v ∈ [0,1]). */
const rgbToHsv = (r: number, g: number, b: number): [number, number, number] => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
};

/** HSV → RGB (0-255). */
const hsvToRgb = (h: number, s: number, v: number): [number, number, number] => {
  const c = v * s;
  const hh = (h / 60) % 6;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let rgb: [number, number, number];
  if (hh < 1) rgb = [c, x, 0];
  else if (hh < 2) rgb = [x, c, 0];
  else if (hh < 3) rgb = [0, c, x];
  else if (hh < 4) rgb = [0, x, c];
  else if (hh < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const [r, g, b] = rgb;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
};

/** Interpolate between two HSV colours along the shortest hue arc. */
const lerpHsv = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => {
  let [h0] = a;
  const [, s0, v0] = a;
  let [h1] = b;
  const [, s1, v1] = b;
  const dh = h1 - h0;
  if (dh > 180) h0 += 360;
  else if (dh < -180) h1 += 360;
  const h = (h0 + (h1 - h0) * t + 360) % 360;
  const s = s0 + (s1 - s0) * t;
  const v = v0 + (v1 - v0) * t;
  return [h, s, v];
};

/**
 * Build `n` interpolated colours through the given hex stops. `n=1` returns the first stop.
 */
const buildSwatch = (stops: readonly string[], n: number): readonly string[] => {
  if (stops.length === 0) throw new Error('gradient: at least one stop is required');
  if (n <= 0) return [];
  const hsvStops = stops.map((s) => rgbToHsv(...hexToRgb(s)));
  if (n === 1) {
    const first = hsvStops[0];
    if (!first) return [];
    const [r, g, b] = hsvToRgb(...first);
    return [ansi(r, g, b)];
  }
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const segCount = hsvStops.length - 1;
    const segT = t * segCount;
    const idx = Math.min(Math.floor(segT), segCount - 1);
    const localT = segT - idx;
    const a = hsvStops[idx];
    const b = hsvStops[idx + 1];
    if (!a || !b) continue;
    const [h, s, v] = lerpHsv(a, b, localT);
    const [r, gg, bb] = hsvToRgb(h, s, v);
    out.push(ansi(r, gg, bb));
  }
  return out;
};

/**
 * Paint each visible character of `text` with a gradient sweep across the supplied hex stops.
 * Whitespace is left uncoloured to keep transparent gaps in ASCII art.
 *
 * Iteration is by Unicode code point (`[...text]`) so surrogate-pair glyphs like emoji aren't
 * split by the ANSI escape inserted between characters. UTF-16 indexing would cut 🍩 in half
 * and the terminal would render `��` replacement marks.
 */
export const paintLine = (text: string, stops: readonly string[]): string => {
  if (text.length === 0) return '';
  const chars = [...text];
  const swatch = buildSwatch(stops, chars.length);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? '';
    if (ch === ' ' || ch === '\t') {
      out += ch;
      continue;
    }
    out += `${swatch[i] ?? ''}${ch}`;
  }
  return `${out}${RESET}`;
};

/** Paint each line of a multi-line block independently — same gradient, fresh sweep per row. */
export const paintMultiline = (text: string, stops: readonly string[]): string =>
  text
    .split('\n')
    .map((line) => paintLine(line, stops))
    .join('\n');

/** Curated palettes used by the TUI. */
export const palettes = {
  /** Gold → Orange → Hot Pink → Orchid → Violet — Ralph's signature donut warmth. */
  donut: ['#FFD700', '#FFA500', '#FF69B4', '#DA70D6', '#9400D3'],
  /** Green → Cyan — completion. */
  success: ['#7FB069', '#6CA6B0'],
  /** Coral → Amber — attention. */
  warning: ['#E76F51', '#E8A13B'],
} as const;
