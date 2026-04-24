import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { RouterProvider, type RouterApi } from '@src/integration/ui/tui/views/router-context.ts';

const confirmMock = vi.fn<(opts: { message: string; default?: boolean }) => Promise<boolean>>();

vi.mock('@src/integration/bootstrap.ts', () => ({
  getPrompt: () => ({
    confirm: (opts: { message: string; default?: boolean }) => confirmMock(opts),
  }),
}));

import { RemovalWorkflow } from './removal-workflow.tsx';

const routerStub: RouterApi = {
  current: { id: 'sprint-delete' },
  stack: [{ id: 'home' }, { id: 'sprint-delete' }],
  push: vi.fn(),
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
};

function withRouter(node: React.ReactElement): React.ReactElement {
  return <RouterProvider value={routerStub}>{node}</RouterProvider>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('RemovalWorkflow', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls onConfirm exactly once and renders success state when user confirms Y', async () => {
    confirmMock.mockResolvedValue(true);
    const onConfirm = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const onDone = vi.fn();

    const { lastFrame } = render(
      withRouter(
        <RemovalWorkflow
          entityLabel="Delete Widget"
          confirmMessage='Delete "Widget"? This cannot be undone.'
          onConfirm={onConfirm}
          successMessage="Widget deleted"
          onDone={onDone}
        />
      )
    );
    await flush();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledWith({
      message: 'Delete "Widget"? This cannot be undone.',
      default: false,
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(lastFrame() ?? '').toContain('Widget deleted');
    // SectionStamp uppercases the title — confirms ViewShell wraps the body.
    expect(lastFrame() ?? '').toContain('DELETE WIDGET');
  });

  it('does not call onConfirm when user declines (n) and renders a cancelled done state', async () => {
    confirmMock.mockResolvedValue(false);
    const onConfirm = vi.fn<() => Promise<void>>();
    const onDone = vi.fn();

    const { lastFrame } = render(
      withRouter(
        <RemovalWorkflow
          entityLabel="Remove Project"
          confirmMessage='Remove "demo"?'
          onConfirm={onConfirm}
          successMessage="Project removed"
          onDone={onDone}
        />
      )
    );
    await flush();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Removal cancelled');
    expect(frame).not.toContain('Project removed');
  });

  it('renders the error state with the thrown message when onConfirm rejects', async () => {
    confirmMock.mockResolvedValue(true);
    const onConfirm = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('disk full'));
    const onDone = vi.fn();

    const { lastFrame } = render(
      withRouter(
        <RemovalWorkflow
          entityLabel="Remove Task"
          confirmMessage='Remove "t1"?'
          onConfirm={onConfirm}
          successMessage="Task removed"
          onDone={onDone}
        />
      )
    );
    await flush();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Could not complete Remove Task');
    expect(frame).toContain('disk full');
  });

  it('calls onDone when the user presses Enter from a terminal state', async () => {
    confirmMock.mockResolvedValue(false);
    const onConfirm = vi.fn<() => Promise<void>>();
    const onDone = vi.fn();

    const { stdin } = render(
      withRouter(
        <RemovalWorkflow
          entityLabel="Remove Ticket"
          confirmMessage='Remove "t1"?'
          onConfirm={onConfirm}
          successMessage="Ticket removed"
          onDone={onDone}
        />
      )
    );
    await flush();

    stdin.write('\r');
    await flush();

    expect(onDone).toHaveBeenCalled();
  });

  it('pops back via onDone when the confirm prompt is cancelled (Ctrl+C / Escape)', async () => {
    const { PromptCancelledError } = await import('@src/business/ports/prompt.ts');
    confirmMock.mockRejectedValue(new PromptCancelledError());
    const onConfirm = vi.fn<() => Promise<void>>();
    const onDone = vi.fn();

    render(
      withRouter(
        <RemovalWorkflow
          entityLabel="Remove Widget"
          confirmMessage='Remove "w"?'
          onConfirm={onConfirm}
          successMessage="Widget removed"
          onDone={onDone}
        />
      )
    );
    await flush();

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
