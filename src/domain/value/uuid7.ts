import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 — 48-bit Unix-millis timestamp + 4-bit version (`7`) + 12-bit random + 2-bit variant
 * + 62-bit random. Lex-sortable by creation time, so an array of UUIDv7s is naturally ordered
 * chronologically without a separate index.
 *
 * Spec: https://datatracker.ietf.org/doc/html/rfc9562#name-uuid-version-7
 */

export const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isUuidv7 = (s: string): boolean => UUIDV7_REGEX.test(s);

const toHex = (buf: Buffer, offset: number, length: number): string =>
  buf.subarray(offset, offset + length).toString('hex');

/**
 * Sub-millisecond monotonic counter (RFC 9562 §6.2 Method 1 — "Fixed Bit-Length Dedicated
 * Counter"). `Date.now()` only has millisecond resolution, so two IDs minted in the same ms
 * would otherwise embed independent random bits in the sub-ms region and sort arbitrarily
 * relative to each other. We instead spend the 12-bit `rand_a` field on a per-ms sequence:
 *
 *  - new millisecond → reset the counter to 0;
 *  - same millisecond → increment;
 *  - counter overflow (a >4096-ID burst inside one ms) → advance the embedded timestamp by 1ms
 *    and restart the counter, so the next ID still sorts strictly after the last.
 *
 * `rand_b` (62 bits) stays fully random, so collisions across processes / restarts remain
 * astronomically unlikely. The output shape is unchanged — every ID still matches
 * {@link UUIDV7_REGEX}.
 */
const MAX_SEQ = 0xfff; // 12-bit counter living in the rand_a field
let lastMs = -1;
let seq = 0;

export const uuidv7 = (): string => {
  let ts = Date.now();
  if (ts > lastMs) {
    lastMs = ts;
    seq = 0;
  } else {
    // Same ms (or a backwards clock step) — bump the counter to keep IDs strictly ascending.
    seq += 1;
    if (seq > MAX_SEQ) {
      // Counter exhausted within one ms: borrow from the timestamp so ordering is preserved.
      lastMs += 1;
      ts = lastMs;
      seq = 0;
    } else {
      ts = lastMs;
    }
  }

  // 48-bit timestamp → 12 hex chars
  const tsHex = ts.toString(16).padStart(12, '0');

  const rand = randomBytes(10);
  // Embed the 12-bit sequence in rand_a (bytes 0–1, low 12 bits), then stamp version 7 on the
  // top nibble of byte 0 → `0111 ssss ssss ssss`.
  rand[0] = 0x70 | ((seq >> 8) & 0x0f);
  rand[1] = seq & 0xff;
  // Set variant (2 high bits of byte 2) → 10xx
  rand[2] = ((rand[2] ?? 0) & 0x3f) | 0x80;

  const part3 = toHex(rand, 0, 2); // 7sss
  const part4 = toHex(rand, 2, 2); // [89ab]xxx
  const part5 = toHex(rand, 4, 6); // 12 hex chars

  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-${part3}-${part4}-${part5}`;
};
