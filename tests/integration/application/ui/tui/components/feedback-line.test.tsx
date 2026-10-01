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

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { FeedbackLine, feedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
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

describe('FeedbackLine — colour', () => {
  // chalk is ink's own dependency; load the instance ink uses and raise its level for this block.
  const loadChalk = async (): Promise<{ level: number }> => {
    const path = createRequire(import.meta.url).resolve('ink');
    const chalkPath = createRequire(path).resolve('chalk');
    return ((await import(pathToFileURL(chalkPath).href)) as { default: { level: number } }).default;
  };
  const sgr = (hex: string): string => {
    const n = Number.parseInt(hex.slice(1), 16);
    return `\x1b[38;2;${String((n >> 16) & 0xff)};${String((n >> 8) & 0xff)};${String(n & 0xff)}m`;
  };

  const frameAt = async (text: string): Promise<string> => {
    const chalk = await loadChalk();
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const r = render(<FeedbackLine text={text} />);
      await tick(20);
      const frame = r.lastFrame() ?? '';
      r.unmount();
      return frame;
    } finally {
      chalk.level = prev;
    }
  };

  it('a plain string starting with the check glyph renders in success, not primary', async () => {
    const frame = await frameAt(`${glyphs.check} saved`);
    expect(frame).toContain(sgr(inkColors.success));
    expect(frame).not.toContain(sgr(inkColors.primary));
  });

  it('a structured warning tone renders the warning glyph in the warning colour', async () => {
    const chalk = await loadChalk();
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const r = render(<FeedbackLine text={feedback('warning', 'careful')} />);
      await tick(20);
      const frame = r.lastFrame() ?? '';
      r.unmount();
      expect(frame).toContain(glyphs.warningGlyph);
      expect(frame).toContain(sgr(inkColors.warning));
    } finally {
      chalk.level = prev;
    }
  });

  it('does not double a status glyph the structured text already leads with', async () => {
    const r = render(<FeedbackLine text={feedback('success', `${glyphs.check} enabled "x" for 2 flow(s)`)} />);
    await tick(20);
    const frame = r.lastFrame() ?? '';
    r.unmount();
    expect(frame).toContain(`${glyphs.check} enabled`);
    expect(frame).not.toContain(`${glyphs.check} ${glyphs.check}`);
  });
});
