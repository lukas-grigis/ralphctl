import { describe, expect, it } from 'vitest';
import { renderTicketRefsSection } from '@src/integration/ai/prompts/_engine/renderers/task.ts';

describe('renderTicketRefsSection', () => {
  it('renders a single `Closes <ref>` line for a single-element refs array', () => {
    expect(renderTicketRefsSection(['#123'])).toBe('Closes #123');
  });

  it('renders one `Closes <ref>` line per ref, newline-joined', () => {
    expect(renderTicketRefsSection(['#123', '!456'])).toBe('Closes #123\nCloses !456');
  });

  it('returns the empty string for undefined', () => {
    expect(renderTicketRefsSection(undefined)).toBe('');
  });

  it('returns the empty string for an empty array', () => {
    expect(renderTicketRefsSection([])).toBe('');
  });

  it('dedupes repeated refs (set-style) while preserving first-seen order', () => {
    expect(renderTicketRefsSection(['#123', '#123', '!456', '#123'])).toBe('Closes #123\nCloses !456');
  });

  it('drops whitespace-only entries and trims survivors', () => {
    expect(renderTicketRefsSection(['  #123  ', '', '  ', '\t#999'])).toBe('Closes #123\nCloses #999');
  });

  it('returns empty when every entry is whitespace-only', () => {
    expect(renderTicketRefsSection(['  ', '\t', ''])).toBe('');
  });
});
