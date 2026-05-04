/**
 * End-to-end smoke tests for the built CLI binary.
 *
 * Each test spawns `node dist/cli.mjs <args>` as a child process against a
 * temp `RALPHCTL_ROOT` and asserts on real stdout / stderr / exit codes.
 * Unlike `src/application/cli/cli.test.ts`, which calls command functions
 * directly with a wired `SharedDeps`, these tests exercise the full bundled
 * artefact — the exact bytes published to npm.
 *
 * Auto-build: if `dist/cli.mjs` is missing when the suite starts, `beforeAll`
 * runs `pnpm build` synchronously so `pnpm test` works on a fresh checkout
 * without a preceding manual build step.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.mjs');

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

function runCli(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  // Force the JSON sink so the binary never tries to take over the terminal
  // (alt-screen mount, raw stdin) under vitest's child-process pipe.
  // Drop `VITEST` from the child env — the logger detects it and silences
  // info-level output, which would empty the stdout we want to assert on.
  const parentEnv = { ...process.env };
  delete parentEnv['VITEST'];
  delete parentEnv['VITEST_POOL_ID'];
  delete parentEnv['VITEST_WORKER_ID'];
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    ...extraEnv,
    RALPHCTL_NO_TUI: '1',
    RALPHCTL_JSON: '1',
    NO_COLOR: '1',
    CI: '1',
  };
  const opts: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf-8',
    env,
    timeout: 20_000,
  };
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], opts);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? -1,
  };
}

describe('CLI e2e smoke (built dist/cli.mjs)', () => {
  let tmpRoot: string;

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      const build = spawnSync('pnpm', ['build'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: 60_000,
      });
      if (build.status !== 0) {
        throw new Error(`pnpm build failed (status ${String(build.status ?? -1)}):\n${build.stdout}\n${build.stderr}`);
      }
      if (!existsSync(CLI_PATH)) {
        throw new Error(`pnpm build completed but dist/cli.mjs is still missing at ${CLI_PATH}.`);
      }
    }
    tmpRoot = mkdtempSync(join(tmpdir(), 'ralphctl-e2e-'));
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function withTmpRoot(): NodeJS.ProcessEnv {
    return { RALPHCTL_ROOT: tmpRoot };
  }

  it('--version prints a semver and exits 0', () => {
    const r = runCli(['--version'], withTmpRoot());
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help shows the command list and exits 0', () => {
    const r = runCli(['--help'], withTmpRoot());
    expect(r.status).toBe(0);
    // Commander prints "Commands:" or a similar capability list.
    expect(r.stdout).toMatch(/Commands?:|Usage:/i);
  });

  it('doctor on a fresh root runs every check and does not hard-fail (no projects yet)', () => {
    const r = runCli(['doctor'], withTmpRoot());
    // Exits 0 (or 1 if e.g. an upstream binary is missing on this CI box —
    // the suite is permissive here; just assert that the report shape is
    // present).
    expect([0, 1]).toContain(r.status);
    expect(r.stdout + r.stderr).toMatch(/Doctor/i);
  });

  it('project list on an empty root reports no projects', () => {
    const r = runCli(['project', 'list'], withTmpRoot());
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/No projects/i);
  });

  it('sprint list on an empty root reports no sprints', () => {
    const r = runCli(['sprint', 'list'], withTmpRoot());
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/No sprints/i);
  });

  it('config show prints the default config keys', () => {
    const r = runCli(['config', 'show'], withTmpRoot());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/aiProvider/);
    expect(r.stdout).toMatch(/evaluationIterations/);
  });

  it('sessions list on an empty root reports no sessions', () => {
    const r = runCli(['sessions', 'list'], withTmpRoot());
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/No active sessions|no sessions/i);
  });

  it('completion show --shell bash emits a bash completion fragment', () => {
    const r = runCli(['completion', 'show', '--shell', 'bash'], withTmpRoot());
    expect(r.status).toBe(0);
    // Bash completion uses `complete -F` to bind a function. Match either
    // that or a known marker word the script always emits.
    expect(r.stdout).toMatch(/complete\s+-F|_ralphctl/);
  });

  it('project add --name … --display-name … --repo-path … succeeds and persists', () => {
    const repoPath = '/tmp/ralphctl-e2e-fake-repo';
    const r = runCli(
      ['project', 'add', '--name', 'demo', '--display-name', 'Demo', '--repo-path', repoPath],
      withTmpRoot()
    );
    expect(r.status).toBe(0);
    // Verify by re-reading via `project list`.
    const list = runCli(['project', 'list'], withTmpRoot());
    expect(list.stdout).toContain('demo');
  });

  it('an unknown top-level command exits non-zero with an error message', () => {
    const r = runCli(['definitely-not-a-real-command'], withTmpRoot());
    expect(r.status).not.toBe(0);
    // Commander emits "unknown command" to stderr by default.
    expect((r.stderr + r.stdout).toLowerCase()).toMatch(/unknown command|invalid|error/);
  });
});
