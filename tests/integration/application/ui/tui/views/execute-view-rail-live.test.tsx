/** The runner mutates descriptor.trace and live in place; the projection hook must still advance the strip and the tree. */

import React from 'react';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { describe, expect, it } from 'vitest';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import type { PlanNode } from '@src/application/chain/plan-tree.ts';
import type { SessionDescriptor, SessionLive } from '@src/application/ui/tui/runtime/session-manager.ts';
import { useFlowProgress } from '@src/application/ui/tui/runtime/use-flow-progress.ts';
import { FlowStepsRail } from '@src/application/ui/tui/views/execute-view-internals/rail.tsx';
import { FlowProgressStrip } from '@src/application/ui/tui/components/flow-progress-strip.tsx';

const leaf = (name: string): PlanNode => ({ name, label: name, kind: 'leaf', internal: false, children: [] });
const plan: PlanNode = {
  name: 'root',
  kind: 'sequential',
  internal: false,
  children: ['load-sprint', 'second-step', 'third-step'].map(leaf),
};

const done = (name: string): TraceEntry => ({ elementName: name, status: 'completed', durationMs: 1 });

const Harness = ({ descriptor }: { readonly descriptor: SessionDescriptor }): React.JSX.Element => {
  const progress = useFlowProgress({ descriptor, awaiting: false });
  return (
    <Box flexDirection="column">
      <FlowProgressStrip progress={progress} width={96} />
      <FlowStepsRail progress={progress} isRunning maxRows={10} railWidth={60} />
    </Box>
  );
};

describe('flow steps liveness', () => {
  it('advances strip and tree when steps start and finish on the same descriptor', () => {
    const trace: TraceEntry[] = [];
    const live: SessionLive = { inFlight: new Map(), version: 0 };
    const descriptor = {
      id: 's1',
      flowId: 'plan',
      title: 't',
      status: 'running',
      startedAt: 0,
      trace,
      planTree: plan,
      live,
    } as SessionDescriptor;
    const r = render(<Harness descriptor={descriptor} />);
    const start = (name: string): void => {
      live.inFlight.clear();
      live.inFlight.set(name, { elementName: name });
      live.version += 1;
    };
    start('load-sprint');
    r.rerender(<Harness descriptor={descriptor} />);
    expect(r.lastFrame()).toContain('step 1/3');
    trace.push(done('load-sprint'));
    start('second-step');
    r.rerender(<Harness descriptor={descriptor} />);
    const mid = r.lastFrame() ?? '';
    expect(mid).toContain('step 2/3');
    expect(mid).toContain('■ load-sprint');
    trace.push(done('second-step'));
    start('third-step');
    r.rerender(<Harness descriptor={descriptor} />);
    const after = r.lastFrame() ?? '';
    expect(after).toContain('step 3/3');
    expect(after).toContain('■ second-step');
    r.unmount();
  });
});
