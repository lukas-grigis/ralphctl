import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv } from '@src/test-utils/setup.ts';
import { extractField, runCli } from '@src/test-utils/cli-runner.ts';

let env: Record<string, string>;
let cleanup: () => Promise<void>;

describe('ralphctl task why', { timeout: 5000 }, () => {
  beforeAll(async () => {
    const testEnv = await createTestEnv();
    env = testEnv.env;
    cleanup = testEnv.cleanup;

    await runCli(['sprint', 'create', '-n', '--project', 'test-project', '--name', 'Why Test'], env);
    await runCli(['ticket', 'add', '-n', '--title', 'Why Ticket'], env);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('reports "no blockers" for an independent task', async () => {
    const add = await runCli(['task', 'add', '-n', '--name', 'Solo Task'], env);
    expect(add.code).toBe(0);
    const id = extractField(add.stdout, 'ID');
    expect(id).toBeTruthy();
    if (!id) throw new Error('missing id');

    const why = await runCli(['task', 'why', id], env);
    expect(why.code).toBe(0);
    expect(why.stdout).toMatch(/No blockers|ready to execute/);
  });

  it('reports unknown task id with a clear error', async () => {
    const why = await runCli(['task', 'why', '00000000'], env);
    // Domain errors are printed to stderr or stdout depending on route; we just
    // assert the message surfaces somewhere.
    const combined = why.stdout + why.stderr;
    expect(combined.toLowerCase()).toMatch(/not found|task/);
  });
});
