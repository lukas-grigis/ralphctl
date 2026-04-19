import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv } from '@src/test-utils/setup.ts';
import { runCli } from '@src/test-utils/cli-runner.ts';

let env: Record<string, string>;
let cleanup: () => Promise<void>;

describe('ralphctl next', { timeout: 5000 }, () => {
  beforeAll(async () => {
    const testEnv = await createTestEnv();
    env = testEnv.env;
    cleanup = testEnv.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    // Each test starts with no current sprint by clearing config between scenarios.
    // createTestEnv already registers a 'test-project', so we just reset sprint state.
    const res = await runCli(['sprint', 'list'], env);
    // Clean any draft created by a prior test (best-effort).
    const ids = res.stdout.match(/\b\d{8}-\d{6}-[a-z0-9-]+/g) ?? [];
    for (const id of ids) {
      await runCli(['sprint', 'delete', id, '-y'], env);
    }
  });

  it('suggests sprint create when no current sprint is set', async () => {
    const json = await runCli(['next', '--json'], env);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout.trim()) as {
      sprint: unknown;
      action: unknown;
      reason: string;
    };
    expect(payload.reason).toBe('no-sprint');
    expect(payload.sprint).toBeNull();
    expect(payload.action).toBeNull();
  });

  it('--porcelain emits an empty line when nothing is actionable', async () => {
    const res = await runCli(['next', '--porcelain'], env);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  it('suggests refine when a draft sprint has a pending ticket', async () => {
    await runCli(['sprint', 'create', '-n', '--project', 'test-project', '--name', 'Next Test'], env);
    await runCli(['ticket', 'add', '-n', '--title', 'Needs refinement'], env);

    const porcelain = await runCli(['next', '--porcelain'], env);
    expect(porcelain.code).toBe(0);
    expect(porcelain.stdout.trim()).toBe('ralphctl sprint refine');

    const json = await runCli(['next', '--json'], env);
    const payload = JSON.parse(json.stdout.trim()) as {
      reason: string;
      action: { command: string } | null;
    };
    expect(payload.reason).toBe('action-ready');
    expect(payload.action?.command).toBe('ralphctl sprint refine');
  });
});
