/**
 * End-to-end fence for the parallel implement token-usage hole, exercised through the REAL
 * runners rather than bare `runWithSession` calls.
 *
 * Shape under test (mirrors `parallel-element.ts` → `wave-scheduler.ts` → `wave-branch.ts`): a
 * host runner (`r-host`, the id the Execute view is mounted with) whose element spins up one
 * nested branch runner per task (`task-<taskId>`). Every generator / evaluator spawn happens
 * inside the BRANCH scope, so the `chainSessionId` the provider adapter stamps onto its
 * `TokenUsageEvent` must still be the host id — `useTokenUsage(bus).get(hostId)` is a plain
 * `Map.get`, and a branch-keyed entry can never be found.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import type { Element, ElementResult } from '@src/application/chain/element.ts';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';

const PROMPT = 'nested-runner prompt' as unknown as Prompt;
const SANDBOX = absolutePath('/tmp/sandbox');
const REPO = absolutePath('/tmp/repo');
const SPRINT_DIR = absolutePath('/tmp/sprint');
const SIGNALS = absolutePath('/tmp/sandbox/rounds/1/generator/signals.json');

const TASKS = ['01933fbb-1111-7000-8000-000000000001', '01933fbb-2222-7000-8000-000000000002'] as const;

/** Stands in for the generator leaf: builds the AiSession the provider adapter would consume. */
const spawnLeaf = (record: (chainSessionId: string | undefined) => void): Element<undefined> => ({
  name: 'generator',
  async execute(): Promise<ElementResult<undefined>> {
    const session = implementSession(SANDBOX, REPO, SPRINT_DIR, PROMPT, 'claude-opus-4-8', SIGNALS, 'generator');
    record(session.chainSessionId);
    return Result.ok({ ctx: undefined, trace: [] });
  },
});

/** Stands in for `createParallelImplementElement`: one nested runner per task, run concurrently. */
const fanOut = (record: (chainSessionId: string | undefined) => void): Element<undefined> => ({
  name: 'implement-parallel',
  async execute(): Promise<ElementResult<undefined>> {
    await Promise.all(
      TASKS.map(async (taskId) => {
        const branch = createRunner<undefined>({
          id: `task-${taskId}`,
          element: spawnLeaf(record),
          initialCtx: undefined,
        });
        await branch.start();
      })
    );
    return Result.ok({ ctx: undefined, trace: [] });
  },
});

describe('parallel implement — token-usage session key', () => {
  it('stamps the HOST runner id on every branch spawn, not the per-branch runner id', async () => {
    const stamped: Array<string | undefined> = [];
    const host = createRunner<undefined>({
      id: 'r-host',
      element: fanOut((id) => stamped.push(id)),
      initialCtx: undefined,
    });

    await host.start();

    expect(host.status).toBe('completed');
    expect(stamped).toHaveLength(TASKS.length);
    expect(stamped.every((id) => id === 'r-host')).toBe(true);
  });

  it('still stamps the runner id on the serial path (no nesting)', async () => {
    const stamped: Array<string | undefined> = [];
    const runner = createRunner<undefined>({
      id: 'r-serial',
      element: spawnLeaf((id) => stamped.push(id)),
      initialCtx: undefined,
    });

    await runner.start();

    expect(stamped).toStrictEqual(['r-serial']);
  });
});
