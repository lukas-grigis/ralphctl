import { describe, expect, it } from 'vitest';
import {
  OPENCODE_MODELS,
  isOpencodeModel,
  isOpencodeModelIdShape,
} from '@src/domain/value/settings-models/opencode.ts';

describe('settings-models / opencode catalog', () => {
  it('recognizes every shipped free-tier id', () => {
    for (const m of OPENCODE_MODELS) {
      expect(isOpencodeModel(m)).toBe(true);
    }
  });

  it('rejects ids outside the shipped catalog, including authenticated upstream ones', () => {
    // Not a bug: the catalog is the zero-auth floor, and the adapters gate on shape instead.
    expect(isOpencodeModel('anthropic/claude-opus-5')).toBe(false);
    expect(isOpencodeModel('opencode/not-a-real-model')).toBe(false);
  });
});

describe('settings-models / opencode id shape', () => {
  it('accepts a two-segment provider/model id', () => {
    expect(isOpencodeModelIdShape('opencode/big-pickle')).toBe(true);
    expect(isOpencodeModelIdShape('anthropic/claude-opus-5')).toBe(true);
  });

  it('accepts a three-segment aggregator id', () => {
    // OpenRouter keys carry their own slash; a custom provider declaring a slashed model id does
    // the same. Verified against opencode-ai v1.18.15 — this must not be narrowed to two segments.
    expect(isOpencodeModelIdShape('openrouter/moonshotai/kimi-k2')).toBe(true);
    expect(isOpencodeModelIdShape('myprovider/vendor/slashed-model')).toBe(true);
  });

  it('accepts a four-segment id — segment count is deliberately unbounded', () => {
    expect(isOpencodeModelIdShape('a/b/c/d')).toBe(true);
  });

  it('rejects trailing junk after an otherwise valid id', () => {
    expect(isOpencodeModelIdShape('a/b c')).toBe(false);
    expect(isOpencodeModelIdShape('opencode/big-pickle (default)')).toBe(false);
  });

  it('rejects a bare id with no slash', () => {
    expect(isOpencodeModelIdShape('gpt-5.5')).toBe(false);
    expect(isOpencodeModelIdShape('')).toBe(false);
  });

  it('rejects whitespace anywhere, which is what disqualifies banner lines', () => {
    expect(isOpencodeModelIdShape('Available models:')).toBe(false);
    expect(isOpencodeModelIdShape(' opencode/big-pickle')).toBe(false);
    expect(isOpencodeModelIdShape('opencode/big-pickle ')).toBe(false);
    expect(isOpencodeModelIdShape('open code/big-pickle')).toBe(false);
    expect(isOpencodeModelIdShape('opencode/big\tpickle')).toBe(false);
  });

  it('rejects an empty segment on either side of the slash', () => {
    expect(isOpencodeModelIdShape('/big-pickle')).toBe(false);
    expect(isOpencodeModelIdShape('opencode/')).toBe(false);
  });
});
