import { describe, expect, it } from 'vitest';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';

describe('extractPlaceholders', () => {
  it('returns an empty array for an empty template', () => {
    expect(extractPlaceholders('')).toEqual([]);
  });

  it('returns an empty array when no placeholders are present', () => {
    expect(extractPlaceholders('# Heading\n\nNothing here.')).toEqual([]);
  });

  it('extracts a single placeholder', () => {
    expect(extractPlaceholders('Hello {{NAME}}')).toEqual(['NAME']);
  });

  it('extracts multiple distinct placeholders in first-seen order', () => {
    expect(extractPlaceholders('{{B}} then {{A}} then {{C}}')).toEqual(['B', 'A', 'C']);
  });

  it('deduplicates repeated placeholders, preserving first-seen order', () => {
    expect(extractPlaceholders('{{X}} {{Y}} {{X}} {{Y}}')).toEqual(['X', 'Y']);
  });

  it('ignores malformed placeholders (lowercase, leading digit)', () => {
    expect(extractPlaceholders('{{lower}} {{1BAD}} {{OK}}')).toEqual(['OK']);
  });
});
