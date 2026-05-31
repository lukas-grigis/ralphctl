import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl runs', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  /**
   * Build a run dir under `<runsRoot>/<flow>/<runId>/` and seed it with a `prompt.md`. `ageMs`
   * controls the embedded ISO stamp so test cases can deterministically vet `--older-than`
   * windows; `bodyBytes` controls the byte total `formatBytes` reports.
   */
  const seedRun = async (flow: string, ageMs: number, bodyBytes = 100): Promise<string> => {
    const ts = new Date(Date.now() - ageMs);
    const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    const runId = `${ts.toISOString().replace(/[:.]/g, '-')}-${suffix}`;
    const dir = join(String(cli.paths.runsRoot), flow, runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'prompt.md'), 'x'.repeat(bodyBytes), 'utf8');
    return runId;
  };

  const HOUR = 60 * 60 * 1000;

  describe('list', () => {
    it('reports the empty state on a fresh install and names the resolved path', async () => {
      const result = await runCliCaptured(cli, ['runs', 'list']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no runs yet');
      expect(result.stdout).toContain(String(cli.paths.runsRoot));
    });

    it('groups populated runs per flow and prints a grand total', async () => {
      await seedRun('detect-scripts', 1 * HOUR, 100);
      await seedRun('detect-scripts', 5 * HOUR, 100);
      await seedRun('readiness', 2 * HOUR, 50);

      const result = await runCliCaptured(cli, ['runs', 'list']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('detect-scripts');
      expect(result.stdout).toContain('readiness');
      expect(result.stdout).toContain('total:');
      expect(result.stdout).toContain('3 runs');
    });

    it('honours --flow by restricting rows and totals to one flow', async () => {
      await seedRun('detect-scripts', HOUR);
      await seedRun('readiness', HOUR);

      const result = await runCliCaptured(cli, ['runs', 'list', '--flow', 'readiness']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('readiness');
      expect(result.stdout).not.toContain('detect-scripts');
    });
  });

  describe('prune', () => {
    it('--dry-run --older-than lists candidates and deletes nothing, exit 0', async () => {
      const oldRun = await seedRun('detect-scripts', 5 * HOUR);
      const recent = await seedRun('detect-scripts', 30 * 60 * 1000);

      const result = await runCliCaptured(cli, ['runs', 'prune', '--dry-run', '--older-than', '1h']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('candidates:');
      expect(result.stdout).toContain('detect-scripts');
      const oldStillThere = await fs
        .stat(join(String(cli.paths.runsRoot), 'detect-scripts', oldRun))
        .then(() => true)
        .catch(() => false);
      const recentStillThere = await fs
        .stat(join(String(cli.paths.runsRoot), 'detect-scripts', recent))
        .then(() => true)
        .catch(() => false);
      expect(oldStillThere).toBe(true);
      expect(recentStillThere).toBe(true);
    });

    it('--yes --older-than deletes matching runs and reports freed bytes', async () => {
      const oldRun = await seedRun('detect-scripts', 5 * HOUR, 200);
      const recent = await seedRun('detect-scripts', 30 * 60 * 1000, 200);

      const result = await runCliCaptured(cli, ['runs', 'prune', '--yes', '--older-than', '1h']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('pruned');
      expect(result.stdout).toMatch(/freed \d+/);
      const oldStillThere = await fs
        .stat(join(String(cli.paths.runsRoot), 'detect-scripts', oldRun))
        .then(() => true)
        .catch(() => false);
      const recentStillThere = await fs
        .stat(join(String(cli.paths.runsRoot), 'detect-scripts', recent))
        .then(() => true)
        .catch(() => false);
      expect(oldStillThere).toBe(false);
      expect(recentStillThere).toBe(true);
    });

    it('--yes --keep-last 1 retains exactly the newest run per flow', async () => {
      const oldA = await seedRun('detect-scripts', 5 * HOUR);
      const midA = await seedRun('detect-scripts', 3 * HOUR);
      const newA = await seedRun('detect-scripts', HOUR);

      const result = await runCliCaptured(cli, ['runs', 'prune', '--yes', '--keep-last', '1']);
      expect(result.exitCode).toBe(0);
      const surviving = await fs.readdir(join(String(cli.paths.runsRoot), 'detect-scripts'));
      expect(surviving).toEqual([newA]);
      expect(surviving).not.toContain(oldA);
      expect(surviving).not.toContain(midA);
    });

    it('--flow <missing> exits non-zero with a "no such flow" message', async () => {
      await seedRun('detect-scripts', 5 * HOUR);
      const result = await runCliCaptured(cli, [
        'runs',
        'prune',
        '--flow',
        'not-a-real-flow',
        '--yes',
        '--older-than',
        '1h',
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no such flow 'not-a-real-flow'");
    });

    it('refuses to delete on non-TTY without --yes and prints actionable guidance', async () => {
      await seedRun('detect-scripts', 5 * HOUR);
      const result = await runCliCaptured(cli, ['runs', 'prune', '--older-than', '1h']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--yes');
      expect(result.stderr).toContain('--dry-run');
      const survivors = await fs.readdir(join(String(cli.paths.runsRoot), 'detect-scripts'));
      expect(survivors).toHaveLength(1);
    });

    it('rejects malformed --older-than before scanning the filesystem', async () => {
      await seedRun('detect-scripts', 5 * HOUR);
      const result = await runCliCaptured(cli, ['runs', 'prune', '--yes', '--older-than', '5m']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/unsupported duration suffix 'm'/);
    });

    it('prints "nothing to prune" and exits 0 when the candidate set is empty', async () => {
      await seedRun('detect-scripts', 30 * 60 * 1000);
      const result = await runCliCaptured(cli, ['runs', 'prune', '--yes', '--older-than', '1h']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('nothing to prune');
    });
  });
});
