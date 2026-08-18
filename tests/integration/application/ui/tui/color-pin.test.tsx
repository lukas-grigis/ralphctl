import { describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';

/**
 * Fence for the colour pin in `vitest.config.ts`.
 *
 * Every TUI assertion in this project is a plain-substring check against `lastFrame()`. Ink and
 * chalk decide colour support from the worker's environment, so an ambient `FORCE_COLOR` (Claude
 * Code exports `FORCE_COLOR=3`; several terminal wrappers and CI images do too) used to split
 * those substrings with truecolor SGR codes and turn 27 assertions across 13 files red on a
 * pristine tree. The `env: { FORCE_COLOR: '0' }` pin on both vitest projects makes the suite give
 * the same answer for every developer, agent session and runner.
 *
 * Run this file with `FORCE_COLOR=3` exported — it must still pass.
 */
describe('vitest colour pin', () => {
  it('pins FORCE_COLOR=0 in the worker regardless of the ambient shell', () => {
    expect(process.env['FORCE_COLOR']).toBe('0');
  });

  it('renders a coloured Text with no escape sequences', () => {
    const result = render(<Text color="red">plain</Text>);
    const frame = result.lastFrame() ?? '';
    result.unmount();

    expect(frame).toBe('plain');
    // eslint-disable-next-line no-control-regex
    expect(frame).not.toMatch(/\x1b\[/);
  });
});
