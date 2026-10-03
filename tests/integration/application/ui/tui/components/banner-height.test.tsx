/** The boxed banner needs height: on a short terminal it gives way to the one-line strip so the page body stays on screen. */

import { describe, expect, it } from 'vitest';
import { Banner } from '@src/application/ui/tui/components/banner.tsx';
import { renderAtSize } from '@tests/helpers/render-at-size.tsx';

const frameAt = (columns: number, rows: number): string => {
  const r = renderAtSize(<Banner />, { columns, rows });
  const frame = r.lastFrame() ?? '';
  r.unmount();
  return frame;
};

describe('Banner height', () => {
  it.each([
    [80, 24],
    [100, 30],
    [140, 45],
    [200, 50],
  ])('is the compact strip at %i x %i', (columns, rows) => {
    const frame = frameAt(columns, rows);
    expect(frame).toContain('ralphctl');
    expect(frame.split('\n').filter((l) => l.trim() !== '').length).toBeLessThanOrEqual(2);
  });

  it('keeps the boxed wordmark on a tall, wide terminal', () => {
    const frame = frameAt(140, 60);
    expect(frame).toContain('╭');
    expect(frame).not.toContain('ralphctl ');
    expect(frame.split('\n').length).toBeGreaterThan(8);
  });
});
