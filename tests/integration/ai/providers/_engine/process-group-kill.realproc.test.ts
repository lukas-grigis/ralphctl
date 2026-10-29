import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { RegisteredChild } from '@src/integration/ai/providers/_engine/child-registry.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { isAlive, killQuietly, waitForDeath, writeStubCli } from '@tests/helpers/process-tree.ts';

const posix = process.platform !== 'win32';
const leftovers: number[] = [];

afterEach(() => {
  killQuietly(leftovers.splice(0));
});

const sessionIn = (dir: string, abortSignal?: AbortSignal): AiSession => ({
  prompt: 'stub prompt' as Prompt,
  cwd: absolutePath(dir),
  model: 'claude-sonnet-4-6',
  permissions: READ_ONLY,
  signalsFile: absolutePath(join(dir, 'rounds', '2', 'generator', 'signals.json')),
  role: 'generator',
  ...(abortSignal !== undefined ? { abortSignal } : {}),
});

describe.skipIf(!posix)('headless AI CLI spawns run in their own process group', () => {
  it('abort kills the tool subprocess the CLI forked, not just the CLI', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ralphctl-pgkill-'));
    const stub = await writeStubCli(dir);
    const registered: RegisteredChild[] = [];
    let released = 0;
    const provider = createClaudeProvider({
      rateLimitRetries: 0,
      eventBus: createCapturingBus().bus,
      command: stub.command,
      childRegistry: {
        beforeSpawn: () => {},
        register: (child) => {
          registered.push(child);
          return { noteSessionId: () => {}, release: () => (released += 1) };
        },
      },
    });
    const controller = new AbortController();
    const outcome = provider.generate(sessionIn(dir, controller.signal));
    const { child, grandchild } = await stub.pids();
    leftovers.push(child, grandchild);

    controller.abort();
    const result = await outcome;

    expect(result.ok).toBe(false);
    expect(await waitForDeath([child, grandchild], 3_000)).toBe(true);
    expect(registered).toEqual([
      expect.objectContaining({ pid: child, pgid: child, provider: 'claude-code', role: 'generator' }),
    ]);
    expect(released).toBe(1);
  }, 20_000);

  it('the idle watchdog kills the whole group too', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ralphctl-pgidle-'));
    const stub = await writeStubCli(dir);
    const provider = createClaudeProvider({
      rateLimitRetries: 0,
      eventBus: createCapturingBus().bus,
      command: stub.command,
      // Headroom for the stub to fork before going quiet; any longer just slows the suite.
      idleMs: 500,
    });
    const outcome = provider.generate(sessionIn(dir));
    const { child, grandchild } = await stub.pids();
    leftovers.push(child, grandchild);

    await outcome;

    expect(await waitForDeath([child, grandchild], 3_000)).toBe(true);
  }, 20_000);

  it('a clean CLI exit reaps a background job it left in its group', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ralphctl-pgexit-'));
    const stub = await writeStubCli(dir, 'claude', { exitsAfterFork: true, quietGrandchild: true });
    const provider = createClaudeProvider({
      rateLimitRetries: 0,
      eventBus: createCapturingBus().bus,
      command: stub.command,
      idleMs: 60_000,
    });
    const outcome = provider.generate(sessionIn(dir));
    const { child, grandchild } = await stub.pids();
    leftovers.push(child, grandchild);

    await outcome;

    expect(await waitForDeath([grandchild], 3_000)).toBe(true);
  }, 20_000);

  it('a background job still holding the CLI stdout does not hold the attempt open after the CLI exits', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ralphctl-pgpipe-'));
    const stub = await writeStubCli(dir, 'claude', { exitsAfterFork: true });
    const provider = createClaudeProvider({
      rateLimitRetries: 0,
      eventBus: createCapturingBus().bus,
      command: stub.command,
      // Far past the test timeout: only the exit-time reap can let the attempt settle in time.
      idleMs: 60_000,
    });
    const outcome = provider.generate(sessionIn(dir));
    const { child, grandchild } = await stub.pids();
    leftovers.push(child, grandchild);

    await outcome;

    expect(await waitForDeath([grandchild], 3_000)).toBe(true);
  }, 20_000);

  it('a descendant outside the CLI group still holding stdout does not hold the attempt open', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ralphctl-pgescape-'));
    const stub = await writeStubCli(dir, 'claude', { exitsAfterFork: true, grandchildEscapesGroup: true });
    const provider = createClaudeProvider({
      rateLimitRetries: 0,
      eventBus: createCapturingBus().bus,
      command: stub.command,
      // Far past the test timeout: only a bounded wait after the CLI's exit can settle the attempt.
      idleMs: 60_000,
    });
    const outcome = provider.generate(sessionIn(dir));
    const { child, grandchild } = await stub.pids();
    leftovers.push(child, grandchild);

    await outcome;

    // No group reap reached it (the Windows case, or a setsid escapee), so the bound did the work.
    expect(isAlive(grandchild)).toBe(true);
  }, 20_000);
});
