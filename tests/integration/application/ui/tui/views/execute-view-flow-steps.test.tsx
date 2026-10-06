/** What the Execute view shows for the plan a runner exposes: ticket rows for refine, main steps for a parallel implement. */

import { describe, expect, it, vi } from 'vitest';
import { ExecuteView } from '@src/application/ui/tui/views/execute-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Element } from '@src/application/chain/element.ts';
import type { Trace } from '@src/application/chain/trace.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const bus = { publish: vi.fn(), subscribe: () => () => undefined } as unknown as EventBus;
const deps = { eventBus: bus } as unknown as AppDeps;

type Spec = {
  readonly name: string;
  readonly kind: NonNullable<Element<unknown>['kind']>;
  readonly label?: string;
  readonly workItem?: { readonly kind: 'task' | 'ticket'; readonly id: string };
  readonly children?: readonly Spec[];
};

const el = (s: Spec): Element<unknown> => ({
  name: s.name,
  kind: s.kind,
  ...(s.label !== undefined ? { label: s.label } : {}),
  ...(s.workItem !== undefined ? { display: { workItem: s.workItem } } : {}),
  ...(s.children !== undefined ? { children: s.children.map(el) } : {}),
  execute: () => Promise.reject(new Error('plan-only element')),
});

const leaf = (name: string, label: string): Spec => ({ name, kind: 'leaf', label });

const runnerOf = (id: string, element: Element<unknown>, trace: Trace = []): Runner<unknown> =>
  ({
    id,
    status: 'running',
    ctx: {},
    trace,
    element,
    subscribe: () => () => undefined,
    start: vi.fn(),
    abort: vi.fn(),
  }) as unknown as Runner<unknown>;

const frameOf = async (flowId: string, root: Spec, title: string, trace: Trace = []): Promise<string> => {
  const sessions = createSessionManager();
  sessions.register({ runner: runnerOf('r-1', el(root), trace), flowId, title });
  const { result } = renderView(<ExecuteView />, {
    deps,
    initial: { id: 'execute', props: { sessionId: 'r-1' } },
    sessions,
  });
  await waitForViewReady(result, (f) => f.includes(title));
  const frame = result.lastFrame() ?? '';
  result.unmount();
  return frame;
};

describe('ExecuteView flow steps', () => {
  it('shows ticket rows and no Tasks panel for a refine session', async () => {
    const frame = await frameOf(
      'refine',
      {
        name: 'refine',
        kind: 'sequential',
        children: [
          leaf('load-sprint', 'Load sprint'),
          {
            name: 'refine-tickets',
            kind: 'sequential',
            label: 'Refine tickets',
            children: [
              {
                name: 'refine-t1',
                kind: 'sequential',
                label: 'Login page',
                workItem: { kind: 'ticket', id: 't1' },
                children: [leaf('clarify-t1', 'Clarify')],
              },
            ],
          },
        ],
      },
      'Refine — Steps Demo',
      [
        { elementName: 'load-sprint', status: 'completed', durationMs: 5 },
        { elementName: 'clarify-t1', status: 'failed', durationMs: 5 },
      ]
    );
    expect(frame).toContain('Login page');
    expect(frame).toContain('Steps');
    expect(frame).not.toMatch(/·\s+Tasks\b/);
  });

  it('shows Prepare, Run tasks k/N and Finish for a parallel implement plan', async () => {
    const task = (id: string): Spec => ({
      name: `branch-${id}`,
      kind: 'sequential',
      label: `Task ${id}`,
      workItem: { kind: 'task', id },
      children: [leaf(`generator-${id}`, 'Generate')],
    });
    const frame = await frameOf(
      'implement',
      {
        name: 'implement',
        kind: 'sequential',
        children: [
          {
            name: 'implement-prologue',
            kind: 'sequential',
            label: 'Prepare',
            children: [leaf('load-tasks', 'Load tasks')],
          },
          { name: 'implement-waves', kind: 'sequential', label: 'Run tasks', children: [task('a'), task('b')] },
          { name: 'implement-epilogue', kind: 'sequential', label: 'Finish', children: [leaf('close', 'Close')] },
        ],
      },
      'Implement — Parallel Demo'
    );
    expect(frame).toContain('Prepare');
    expect(frame).toMatch(/Run tasks 0\/2/);
    expect(frame).toContain('Finish');
    expect(frame).not.toMatch(/implement-(prologue|waves|epilogue)|load-tasks/);
  });
});
