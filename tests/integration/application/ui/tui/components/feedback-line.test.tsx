/**
 * FeedbackLine — structured `{ tone, text }` form and legacy plain-string form.
 *
 * Guards:
 *   - Structured `tone: 'success'` renders check glyph in success color.
 *   - Structured `tone: 'error'` renders cross glyph in error color.
 *   - Structured `tone: 'info'` renders refresh glyph in info color.
 *   - Legacy plain string with leading cross renders error-colored (no glyph prefix added).
 *   - Legacy plain string without leading cross renders primary-colored.
 *   - `undefined` renders nothing.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { FeedbackLine, feedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

describe('FeedbackLine — structured form', () => {
  it('renders nothing when text is undefined', async () => {
    const r = render(<FeedbackLine text={undefined} />);
    await tick(20);
    expect(r.lastFrame()).toBe('');
    r.unmount();
  });

  it('success tone includes the check glyph', async () => {
    const r = render(<FeedbackLine text={feedback('success', 'all good')} />);
    await tick(20);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain(glyphs.check);
    expect(frame).toContain('all good');
    r.unmount();
  });

  it('error tone includes the cross glyph', async () => {
    const r = render(<FeedbackLine text={feedback('error', 'something went wrong')} />);
    await tick(20);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain(glyphs.cross);
    expect(frame).toContain('something went wrong');
    r.unmount();
  });

  it('info tone includes the refresh glyph', async () => {
    const r = render(<FeedbackLine text={feedback('info', 'reloading…')} />);
    await tick(20);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain(glyphs.refresh);
    expect(frame).toContain('reloading…');
    r.unmount();
  });
});

describe('FeedbackLine — legacy plain-string form', () => {
  it('renders the text for a string without a cross prefix', async () => {
    const r = render(<FeedbackLine text="plain message" />);
    await tick(20);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('plain message');
    r.unmount();
  });

  it('renders a string with a leading cross glyph', async () => {
    const r = render(<FeedbackLine text={`${glyphs.cross} error happened`} />);
    await tick(20);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain(glyphs.cross);
    expect(frame).toContain('error happened');
    r.unmount();
  });
});
