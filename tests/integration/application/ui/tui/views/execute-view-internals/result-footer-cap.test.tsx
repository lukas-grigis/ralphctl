/**
 * Row budget for the settled `ResultCard`.
 *
 * The Execute page yields the page-scroll keys to the Tasks cursor (`ViewShell
 * suppressScrollArrows`), so anything that grows past the viewport is unreachable by keyboard.
 * Every other section on the page is capped against terminal rows in `use-responsive-layout.ts`;
 * the settled card is capped in `result-footer.tsx`, and this is its fence. The unbounded input
 * is the error summary — `DomainError.message` carries a provider's stderr tail on a real
 * failure.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ResultFooter } from '@src/application/ui/tui/views/execute-view-internals/result-footer.tsx';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { NextSteps } from '@src/application/ui/shared/next-steps.ts';

const descriptorWithError = (message: string): SessionDescriptor =>
  ({
    id: 'r-cap',
    flowId: 'implement',
    title: 'Implement — Capped',
    status: 'failed',
    startedAt: 0,
    finishedAt: 1000,
    trace: [],
    error: { message } as unknown as DomainError,
  }) as unknown as SessionDescriptor;

const renderFooter = (descriptor: SessionDescriptor, nextSteps: NextSteps): string => {
  const r = render(
    <ResultFooter
      descriptor={descriptor}
      isRunning={false}
      tasksDone={1}
      tasksTotal={3}
      elapsed="1s"
      nextSteps={nextSteps}
    />
  );
  const frame = r.lastFrame() ?? '';
  r.unmount();
  return frame;
};

const NO_EXTRAS: NextSteps = { steps: [], forensics: [] };

describe('settled ResultCard row budget', () => {
  it('renders a short error summary verbatim', () => {
    const frame = renderFooter(descriptorWithError('verify gate failed'), NO_EXTRAS);
    expect(frame).toContain('verify gate failed');
    expect(frame).not.toContain('…');
  });

  it('clips a multi-line error summary to its first lines, marked with the clip ellipsis', () => {
    const message = ['line-one', 'line-two', 'line-three', 'line-four-TAIL', 'line-five-TAIL'].join('\n');
    const frame = renderFooter(descriptorWithError(message), NO_EXTRAS);
    expect(frame).toContain('line-one');
    expect(frame).toContain('line-three');
    expect(frame).not.toContain('TAIL');
    expect(frame).toContain('…');
  });

  it('clips a single very long error line so Ink cannot soft-wrap it past the viewport', () => {
    const frame = renderFooter(descriptorWithError(`head ${'x'.repeat(2000)} TAIL`), NO_EXTRAS);
    expect(frame).toContain('head');
    expect(frame).not.toContain('TAIL');
    expect(frame).toContain('…');
  });

  it('caps the next-steps and post-mortem blocks so neither table can grow the card unbounded', () => {
    const nextSteps: NextSteps = {
      steps: Array.from({ length: 12 }, (_, i) => ({ label: `step-${String(i)}` })),
      forensics: Array.from({ length: 12 }, (_, i) => ({ label: `art-${String(i)}`, path: `/tmp/art-${String(i)}` })),
    };
    const frame = renderFooter(descriptorWithError('boom'), nextSteps);
    expect(frame).toContain('step-0');
    expect(frame).not.toContain('step-11');
    expect(frame).toContain('art-0');
    expect(frame).not.toContain('art-11');
  });
});
