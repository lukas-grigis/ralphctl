/** The settled-run card spans the full width — a content-sized card squeezed the Tasks panel beside it. */

import { describe, expect, it } from 'vitest';
import { ResultFooter } from '@src/application/ui/tui/views/execute-view-internals/result-footer.tsx';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import { renderAtSize } from '@tests/helpers/render-at-size.tsx';

const descriptor = {
  id: 'r-1',
  flowId: 'implement',
  title: 'Implement — Demo',
  status: 'completed',
  startedAt: 0,
  trace: [],
} as unknown as SessionDescriptor;

describe('ResultFooter', () => {
  it.each([80, 120])('draws its card edge to edge at %i columns', async (columns) => {
    const r = renderAtSize(
      <ResultFooter
        descriptor={descriptor}
        isRunning={false}
        tasksDone={1}
        tasksTotal={1}
        elapsed="1m"
        nextSteps={{ steps: [], forensics: [] }}
      />,
      { columns, rows: 24 }
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const top = (r.lastFrame() ?? '').split('\n').find((l) => l.startsWith('╭')) ?? '';
    expect([...top.trimEnd()]).toHaveLength(columns);
    r.unmount();
  });
});
