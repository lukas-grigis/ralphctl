/** The runner mutates descriptor.trace in place; the memoised rail must still advance. */

import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import { FlowStepsRail } from '@src/application/ui/tui/views/execute-view-internals/rail.tsx';

const done = (name: string): TraceEntry => ({ elementName: name, status: 'completed', durationMs: 1 });

describe('FlowStepsRail liveness', () => {
  it('advances the running row when steps are pushed onto the same descriptor', () => {
    const trace: TraceEntry[] = [];
    const descriptor = {
      id: 's1',
      flowId: 'implement',
      title: 't',
      status: 'running',
      startedAt: 0,
      trace,
      plannedLeaves: ['load-sprint', 'second-step', 'third-step'],
    } as SessionDescriptor;
    const el = (): React.JSX.Element => <FlowStepsRail descriptor={descriptor} isRunning maxRows={10} railWidth={40} />;
    const r = render(el());
    const spine = (f: string | undefined): string[] => (f ?? '').split('\n');
    const before = r.lastFrame();
    trace.push(done('load-sprint'));
    r.rerender(el());
    const mid = r.lastFrame();
    expect(mid).not.toBe(before);
    trace.push(done('second-step'));
    r.rerender(el());
    const after = r.lastFrame() ?? '';
    expect(after).not.toBe(mid);
    expect(spine(after).find((l) => l.includes('third-step'))).toBeDefined();
    r.unmount();
  });
});
