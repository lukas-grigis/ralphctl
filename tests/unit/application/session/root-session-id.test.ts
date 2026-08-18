/**
 * `rootSessionId()` — the OUTERMOST runner id of the current scope.
 *
 * `currentSessionId()` is deliberately innermost-wins: per-branch logger / signal attribution
 * depends on it. But the TUI's token-usage map is keyed by the id of the runner the Execute view
 * was mounted with — the outer one. On the parallel implement path every generator / evaluator
 * spawn runs inside a per-branch `createRunner({ id: 'task-<taskId>' })`, which re-scopes the ALS
 * store, so a `chainSessionId` taken from `currentSessionId()` filed every event under a key the
 * view never looks up: the header's token / context readout stayed blank for the whole run.
 */

import { describe, expect, it } from 'vitest';
import { currentSessionId, rootSessionId, runWithSession } from '@src/application/session/session.ts';

describe('rootSessionId', () => {
  it('is undefined outside any scope', () => {
    expect(rootSessionId()).toBeUndefined();
  });

  it('equals the current id for a single (serial-path) scope', async () => {
    await runWithSession('r-serial', async () => {
      expect(rootSessionId()).toBe('r-serial');
      expect(currentSessionId()).toBe('r-serial');
    });
  });

  it('keeps the OUTER id while a nested branch runner shadows the current id', async () => {
    await runWithSession('r-host', async () => {
      await runWithSession('task-01933fbb', async () => {
        expect(currentSessionId()).toBe('task-01933fbb');
        expect(rootSessionId()).toBe('r-host');
      });
      expect(rootSessionId()).toBe('r-host');
    });
  });

  it('survives arbitrary nesting depth (branch runner inside a sub-runner)', async () => {
    await runWithSession('r-host', async () => {
      await runWithSession('prologue', async () => {
        await runWithSession('task-1', async () => {
          expect(rootSessionId()).toBe('r-host');
        });
      });
    });
  });

  it('resolves each concurrently interleaved branch to the SAME root but its own current id', async () => {
    const observed: Array<{ current: string | undefined; root: string | undefined }> = [];
    await runWithSession('r-host', async () => {
      await Promise.all(
        ['task-a', 'task-b', 'task-c'].map((id) =>
          runWithSession(id, async () => {
            await Promise.resolve();
            observed.push({ current: currentSessionId(), root: rootSessionId() });
          })
        )
      );
    });

    expect(observed.map((o) => o.current).sort()).toStrictEqual(['task-a', 'task-b', 'task-c']);
    expect(observed.every((o) => o.root === 'r-host')).toBe(true);
  });
});
