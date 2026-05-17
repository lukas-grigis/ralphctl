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

export const uuidv7 = (): string => {
  const ts = Date.now();
  // 48-bit timestamp → 12 hex chars
  const tsHex = ts.toString(16).padStart(12, '0');

  const rand = randomBytes(10);
  // Set version (4 high bits of byte 0) → 0111
  rand[0] = ((rand[0] ?? 0) & 0x0f) | 0x70;
  // Set variant (2 high bits of byte 2) → 10xx
  rand[2] = ((rand[2] ?? 0) & 0x3f) | 0x80;

  const part3 = toHex(rand, 0, 2); // 7xxx
  const part4 = toHex(rand, 2, 2); // [89ab]xxx
  const part5 = toHex(rand, 4, 6); // 12 hex chars

  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-${part3}-${part4}-${part5}`;
};
