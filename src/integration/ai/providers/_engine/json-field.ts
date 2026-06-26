/**
 * Tiny JSON-narrowing helpers shared by the provider stream parsers (claude / copilot / codex).
 *
 * Each adapter reads loosely-typed `Record<string, unknown>` envelopes off the CLI stream and
 * needs the same three primitives: pull the first string/number field by any of several candidate
 * names (CLIs rename keys across versions), and an object guard. The trio was copy-pasted
 * byte-for-byte across the adapters; it lives here in the sanctioned `_engine/` seam so the
 * siblings share one definition instead of drifting.
 */

/** First field in `names` whose value is a string, else undefined. */
export const stringField = (obj: Record<string, unknown>, ...names: readonly string[]): string | undefined => {
  for (const name of names) {
    const v = obj[name];
    if (typeof v === 'string') return v;
  }
  return undefined;
};

/** First field in `names` whose value is a finite number, else undefined. */
export const numberField = (obj: Record<string, unknown>, ...names: readonly string[]): number | undefined => {
  for (const name of names) {
    const v = obj[name];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
};

/** Narrow an unknown to a plain object (non-null). */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
