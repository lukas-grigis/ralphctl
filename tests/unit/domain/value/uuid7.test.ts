import { describe, expect, it } from 'vitest';
import { isUuidv7, uuidv7, UUIDV7_REGEX } from '@src/domain/value/uuid7.ts';

describe('uuidv7', () => {
  it('produces a value matching the UUIDv7 shape', () => {
    for (let i = 0; i < 50; i++) {
      const id = uuidv7();
      expect(UUIDV7_REGEX.test(id)).toBe(true);
      expect(isUuidv7(id)).toBe(true);
    }
  });

  it('produces unique values across N generations', () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(uuidv7());
    expect(set.size).toBe(1000);
  });

  it('lex-sorts chronologically — later values sort after earlier ones', async () => {
    const first = uuidv7();
    await new Promise((r) => setTimeout(r, 5));
    const second = uuidv7();
    expect(first < second).toBe(true);
  });

  it('is monotonic within a millisecond — 1000 IDs in a tight loop sort strictly ascending', () => {
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) ids.push(uuidv7());
    for (let i = 1; i < ids.length; i++) {
      // Strictly ascending: no two consecutive IDs may be equal or inverted, even same-ms.
      expect(ids[i - 1]! < ids[i]!).toBe(true);
    }
  });

  it('keeps the UUIDv7 shape after the monotonic-counter change (every same-ms id is valid)', () => {
    for (let i = 0; i < 1000; i++) {
      expect(UUIDV7_REGEX.test(uuidv7())).toBe(true);
    }
  });

  it('rejects non-UUIDv7 strings', () => {
    expect(isUuidv7('')).toBe(false);
    expect(isUuidv7('not-a-uuid')).toBe(false);
    // valid UUIDv4, not v7
    expect(isUuidv7('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')).toBe(false);
    // v7 but bad variant nibble
    expect(isUuidv7('aaaaaaaa-aaaa-7aaa-faaa-aaaaaaaaaaaa')).toBe(false);
  });
});
