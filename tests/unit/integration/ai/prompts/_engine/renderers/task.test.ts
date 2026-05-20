import { describe, expect, it } from 'vitest';
import { renderTicketRefsSection } from '@src/integration/ai/prompts/_engine/renderers/task.ts';

describe('renderTicketRefsSection', () => {
  it('renders a single git-trailer line for a non-empty refs array', () => {
    expect(renderTicketRefsSection(['#123'])).toBe('Refs: #123');
    expect(renderTicketRefsSection(['#123', '!456'])).toBe('Refs: #123, !456');
  });

  it('returns the empty string for undefined', () => {
    expect(renderTicketRefsSection(undefined)).toBe('');
  });

  it('returns the empty string for an empty array', () => {
    expect(renderTicketRefsSection([])).toBe('');
  });

  it('dedupes repeated refs (set-style) while preserving first-seen order', () => {
    expect(renderTicketRefsSection(['#123', '#123', '!456', '#123'])).toBe('Refs: #123, !456');
  });

  it('drops whitespace-only entries and trims survivors', () => {
    expect(renderTicketRefsSection(['  #123  ', '', '  ', '\t#999'])).toBe('Refs: #123, #999');
  });

  it('returns empty when every entry is whitespace-only', () => {
    expect(renderTicketRefsSection(['  ', '\t', ''])).toBe('');
  });
});
