import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import {
  type CancelHandlers,
  useCancelHandlers,
} from '@src/application/ui/tui/views/execute-view-internals/use-cancel-handlers.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

describe('useCancelHandlers — stop run and mark blocked', () => {
  it('still aborts the session when blocking the active task throws', async () => {
    const abort = vi.fn();
    const taskRepo = {
      findById: () => Promise.reject(new Error('disk gone')),
    } as unknown as AppDeps['taskRepo'];
    let handlers: CancelHandlers | undefined;
    const Probe = (): React.JSX.Element => {
      handlers = useCancelHandlers({
        sessions: { abort } as unknown as SessionManager,
        sessionId: 's-1',
        sprintId: 'sprint-1' as SprintId,
        currentTask: { id: 'task-1' } as unknown as TaskBucket,
        taskRepo,
        logger: noopLogger,
        setCancelScopeOpen: () => undefined,
      });
      return <Text>probe</Text>;
    };
    const { unmount } = render(<Probe />);
    handlers?.onCancelFlow();
    await new Promise((r) => setTimeout(r, 20));
    expect(abort).toHaveBeenCalledWith('s-1');
    unmount();
  });
});
