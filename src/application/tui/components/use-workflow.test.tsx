/**
 * Tests for `useWorkflow` — focuses on hint propagation across the rejection
 * boundary. The hook is consumed via React's render cycle, so we exercise it
 * inside an Ink test renderer harness with a tiny harness component that
 * exposes the current phase as JSON.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';

import { useWorkflow, type WorkflowPhase } from './use-workflow.ts';

function rejectWith(err: unknown): Promise<never> {
  // Wrap an arbitrary value in a Promise rejection without tripping the
  // `prefer-promise-reject-errors` rule (we want to test non-Error rejection
  // shapes too) or `require-await` (no async wrapper).
  return Promise.resolve().then(() => {
    throw err;
  });
}

function HarnessThrow({ err }: { readonly err: unknown }): React.JSX.Element {
  const { phase, run } = useWorkflow<string>();
  // Test harness fires the worker exactly once on mount; `run` is stable and
  // `err` is fixed for the lifetime of this test render.
  React.useEffect(() => {
    run('start', () => rejectWith(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Text>{JSON.stringify(phase)}</Text>;
}

async function waitDone<T>(getPhase: () => WorkflowPhase<T>, timeoutMs = 1000): Promise<WorkflowPhase<T>> {
  const start = Date.now();
  // Poll by re-querying the live frame and parsing the JSON the harness emits.
  // Avoids fighting React internals — useEffect resolution lands within a
  // micro-task on next tick, which is well under the budget.
  while (Date.now() - start < timeoutMs) {
    const p = getPhase();
    if (p.kind === 'done') return p;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting for workflow.done');
}

function renderAndParse(err: unknown): { lastFrame: () => string | undefined } {
  const { lastFrame } = render(<HarnessThrow err={err} />);
  return { lastFrame: () => lastFrame() ?? undefined };
}

describe('useWorkflow', () => {
  it('exposes a stringified error message on rejection', async () => {
    const { lastFrame } = renderAndParse(new Error('boom'));
    const phase = await waitDone(() => JSON.parse(lastFrame() ?? '{}') as WorkflowPhase<string>);
    if (phase.kind !== 'done' || phase.error === null) throw new Error('expected error phase');
    expect(phase.error).toBe('boom');
    expect(phase.hint).toBeUndefined();
  });

  it('propagates the `hint` field when the rejected error carries one', async () => {
    const err = Object.assign(new Error('sprint not found'), { hint: 'Run `ralphctl sprint list`.' });
    const { lastFrame } = renderAndParse(err);
    const phase = await waitDone(() => JSON.parse(lastFrame() ?? '{}') as WorkflowPhase<string>);
    if (phase.kind !== 'done' || phase.error === null) throw new Error('expected error phase');
    expect(phase.error).toBe('sprint not found');
    expect(phase.hint).toBe('Run `ralphctl sprint list`.');
  });

  it('omits hint when the value is not a non-empty string', async () => {
    const err = Object.assign(new Error('boom'), { hint: '' });
    const { lastFrame } = renderAndParse(err);
    const phase = await waitDone(() => JSON.parse(lastFrame() ?? '{}') as WorkflowPhase<string>);
    if (phase.kind !== 'done' || phase.error === null) throw new Error('expected error phase');
    expect(phase.hint).toBeUndefined();
  });

  it('handles non-Error rejections (string)', async () => {
    const { lastFrame } = renderAndParse('plain string');
    const phase = await waitDone(() => JSON.parse(lastFrame() ?? '{}') as WorkflowPhase<string>);
    if (phase.kind !== 'done' || phase.error === null) throw new Error('expected error phase');
    expect(phase.error).toBe('plain string');
  });

  it('does not call the worker when reset() is invoked from idle', () => {
    function ResetHarness(): React.JSX.Element {
      const { phase, reset } = useWorkflow<string>();
      // Exercising reset on idle should be a no-op. Fire-once on mount —
      // `reset` is stable for the lifetime of this test render.
      React.useEffect(() => {
        reset();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <Text>{JSON.stringify(phase)}</Text>;
    }
    const { lastFrame } = render(<ResetHarness />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('idle');
  });
});
