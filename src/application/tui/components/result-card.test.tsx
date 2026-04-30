import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

import { ResultCard } from './result-card.tsx';

describe('ResultCard', () => {
  it('renders the title', () => {
    const { lastFrame } = render(<ResultCard kind="success" title="All good" />);
    expect(lastFrame() ?? '').toContain('All good');
  });

  it('renders fields when provided', () => {
    const { lastFrame } = render(
      <ResultCard
        kind="success"
        title="Done"
        fields={[
          ['sprint', 'demo'],
          ['status', 'closed'],
        ]}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('sprint');
    expect(frame).toContain('demo');
  });

  it('renders the hint line when hint is provided', () => {
    const { lastFrame } = render(
      <ResultCard kind="error" title="Sprint not found" hint="Run `ralphctl sprint list`." />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Sprint not found');
    expect(frame).toContain('hint:');
    expect(frame).toContain('ralphctl sprint list');
  });

  it('omits the hint line when hint is undefined', () => {
    const { lastFrame } = render(<ResultCard kind="error" title="Boom" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Boom');
    expect(frame).not.toContain('hint:');
  });

  it('omits the hint line when hint is an empty string', () => {
    const { lastFrame } = render(<ResultCard kind="info" title="Title" hint="" />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('hint:');
  });

  it('renders next-steps when provided', () => {
    const { lastFrame } = render(
      <ResultCard
        kind="success"
        title="Created"
        nextSteps={[{ action: 'ralphctl sprint show', description: 'inspect details' }]}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Next');
    expect(frame).toContain('ralphctl sprint show');
  });
});
