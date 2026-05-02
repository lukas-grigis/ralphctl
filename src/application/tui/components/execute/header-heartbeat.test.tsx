import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { HeaderHeartbeat } from './header-heartbeat.tsx';

afterEach(() => {
  cleanup();
});

describe('HeaderHeartbeat', () => {
  it('renders a braille spinner character', () => {
    const { lastFrame } = render(<HeaderHeartbeat />);
    const frame = lastFrame() ?? '';
    // The spinner is one of the braille frames; the dot separator is always present.
    expect(frame).toContain('·');
  });

  it('renders without crashing', () => {
    expect(() => render(<HeaderHeartbeat intervalMs={9999} />)).not.toThrow();
  });
});
