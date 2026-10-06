import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { absolutePath, FIXED_NOW } from '@tests/fixtures/domain.ts';
import {
  attributeVerify,
  type ConfirmFailedGate,
  normalizeVerifyGates,
  runVerifyGatesUseCase,
  type RunShellScript,
} from '@src/business/task/run-verify-script.ts';
import type { VerifyGate } from '@src/domain/entity/repository.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/** Local scale constant used to build deliberately large output fixtures (audit-[03]: no
 *  persistence-time cap on rawOutput; the test asserts verbatim round-trip). */
const HUGE_OUTPUT_BYTES = 4096;

const CWD = absolutePath('/tmp/repo');

const passingShell: RunShellScript = async () =>
  Result.ok({ passed: true, exitCode: 0, output: 'OK', durationMs: 100 });

const spawnErrorShell: RunShellScript = async () =>
  Result.error(new StorageError({ subCode: 'io', message: 'spawn ENOENT: command not found' }));

describe('runVerifyGatesUseCase — single legacy verify script', () => {
  it('returns outcome="skipped" when no script configured', async () => {
    const { run, rawOutput } = await runVerifyGatesUseCase({
      cwd: CWD,
      phase: 'pre',
      gates: normalizeVerifyGates(undefined, undefined),
      mode: 'fail-fast',
      clock: () => FIXED_NOW,
      runShellScript: passingShell,
      logger: noopLogger,
    });
    expect(run.outcome).toBe('skipped');
    expect(run.command).toBe('');
    expect(run.exitCode).toBe(0);
    expect(run.durationMs).toBe(0);
    expect(rawOutput).toBe('');
  });

  it('returns outcome="skipped" when script is whitespace-only', async () => {
    const { run } = await runVerifyGatesUseCase({
      cwd: CWD,
      phase: 'pre',
      gates: normalizeVerifyGates('   \n\t ', undefined),
      mode: 'fail-fast',
      clock: () => FIXED_NOW,
      runShellScript: passingShell,
      logger: noopLogger,
    });
    expect(run.outcome).toBe('skipped');
  });

  it('returns outcome="success" with rawOutput when script exits 0 (audit row carries no body)', async () => {
    const { run, rawOutput } = await runVerifyGatesUseCase({
      cwd: CWD,
      phase: 'post',
      gates: normalizeVerifyGates('pnpm test', undefined),
      mode: 'fail-fast',
      clock: () => FIXED_NOW,
      runShellScript: passingShell,
      logger: noopLogger,
    });
    expect(run.outcome).toBe('success');
    expect(run.phase).toBe('post');
    expect(run.exitCode).toBe(0);
    expect(run.durationMs).toBe(100);
    // Audit-[06]: the audit row carries structured metadata only; no embedded tail bytes.
    expect((run as unknown as Record<string, unknown>)['stdoutTailBytes']).toBeUndefined();
    // Audit-[01]: full raw output is the leaf's input for the logs/ persistence.
    expect(rawOutput).toBe('OK');
  });

  it('returns outcome="failed" with full rawOutput when script exits non-zero', async () => {
    const huge = 'A'.repeat(HUGE_OUTPUT_BYTES * 2) + 'FINAL_LINE';
    const { run, rawOutput } = await runVerifyGatesUseCase({
      cwd: CWD,
      phase: 'post',
      gates: normalizeVerifyGates('pnpm test', undefined),
      mode: 'fail-fast',
      clock: () => FIXED_NOW,
      runShellScript: async () => Result.ok({ passed: false, exitCode: 1, output: huge, durationMs: 50 }),
      logger: noopLogger,
    });
    expect(run.outcome).toBe('failed');
    expect(run.exitCode).toBe(1);
    // rawOutput preserves the full body verbatim — no truncation at the use-case boundary.
    expect(rawOutput.length).toBe(huge.length);
    expect(rawOutput).toBe(huge);
  });

  it('returns outcome="spawn-error" with exit=-1 and spawnErrorMessage when the shell could not start', async () => {
    const { run, rawOutput, spawnErrorMessage } = await runVerifyGatesUseCase({
      cwd: CWD,
      phase: 'pre',
      gates: normalizeVerifyGates('missing-binary', undefined),
      mode: 'fail-fast',
      clock: () => FIXED_NOW,
      runShellScript: spawnErrorShell,
      logger: noopLogger,
    });
    expect(run.outcome).toBe('spawn-error');
    expect(run.exitCode).toBe(-1);
    expect(spawnErrorMessage).toContain('spawn ENOENT');
    expect(rawOutput).toBe('');
  });

  it('does NOT call the shell when the script is skipped (no side effects on no-op)', async () => {
    let called = false;
    await runVerifyGatesUseCase({
      cwd: CWD,
      phase: 'pre',
      gates: normalizeVerifyGates(undefined, undefined),
      mode: 'fail-fast',
      clock: () => FIXED_NOW,
      runShellScript: async () => {
        called = true;
        return Result.ok({ passed: true, exitCode: 0, output: '', durationMs: 0 });
      },
      logger: noopLogger,
    });
    expect(called).toBe(false);
  });
});

describe('attributeVerify — truth table', () => {
  it('pre=success, post=success → clean', () => {
    expect(attributeVerify('success', 'success')).toBe('clean');
  });

  it('pre=success, post=failed → regressed', () => {
    expect(attributeVerify('success', 'failed')).toBe('regressed');
  });

  it('pre=failed, post=success → fixed-baseline', () => {
    expect(attributeVerify('failed', 'success')).toBe('fixed-baseline');
  });

  it('pre=failed, post=failed → baseline-broken', () => {
    expect(attributeVerify('failed', 'failed')).toBe('baseline-broken');
  });

  it('pre=spawn-error → undefined (unknown baseline state)', () => {
    expect(attributeVerify('spawn-error', 'success')).toBeUndefined();
    expect(attributeVerify('spawn-error', 'failed')).toBeUndefined();
    expect(attributeVerify('spawn-error', 'spawn-error')).toBeUndefined();
  });

  it('post=spawn-error → undefined (verdict could not run)', () => {
    expect(attributeVerify('success', 'spawn-error')).toBeUndefined();
    expect(attributeVerify('failed', 'spawn-error')).toBeUndefined();
  });

  it('either side=skipped → undefined (nothing to attribute)', () => {
    expect(attributeVerify('skipped', 'skipped')).toBeUndefined();
    expect(attributeVerify('skipped', 'success')).toBeUndefined();
    expect(attributeVerify('skipped', 'failed')).toBeUndefined();
    expect(attributeVerify('success', 'skipped')).toBeUndefined();
    expect(attributeVerify('failed', 'skipped')).toBeUndefined();
  });
});

describe('normalizeVerifyGates — legacy ⇄ structured precedence', () => {
  it('structured gates win when present and non-empty', () => {
    const gates: readonly VerifyGate[] = [{ pathPrefix: 'apps/web', command: 'pnpm --filter web test' }];
    expect(normalizeVerifyGates('pnpm test', gates)).toBe(gates);
  });

  it('legacy script becomes a single catch-all gate when no gates configured', () => {
    expect(normalizeVerifyGates('pnpm test', undefined)).toEqual([{ pathPrefix: '', command: 'pnpm test' }]);
  });

  it('empty gate list falls back to the legacy script', () => {
    expect(normalizeVerifyGates('pnpm test', [])).toEqual([{ pathPrefix: '', command: 'pnpm test' }]);
  });

  it('whitespace-only / absent script with no gates → empty list (skipped run)', () => {
    expect(normalizeVerifyGates('   ', undefined)).toEqual([]);
    expect(normalizeVerifyGates(undefined, undefined)).toEqual([]);
    expect(normalizeVerifyGates(undefined, [])).toEqual([]);
  });
});

describe('runVerifyGatesUseCase — multi-gate execution (T10)', () => {
  // A scripted shell whose per-command result is keyed by the command string so a test can make
  // specific gates pass / fail and assert which actually ran (declaration order, scope, fail-fast).
  const scriptedShell = (
    plan: Readonly<Record<string, { passed: boolean; exitCode: number; output: string; durationMs?: number }>>
  ): { shell: Parameters<typeof runVerifyGatesUseCase>[0]['runShellScript']; ran: () => readonly string[] } => {
    const ran: string[] = [];
    const shell: Parameters<typeof runVerifyGatesUseCase>[0]['runShellScript'] = async (_cwd, command) => {
      ran.push(command);
      const r = plan[command];
      if (r === undefined) return Result.ok({ passed: true, exitCode: 0, output: `${command}-ok`, durationMs: 10 });
      return Result.ok({ passed: r.passed, exitCode: r.exitCode, output: r.output, durationMs: r.durationMs ?? 10 });
    };
    return { shell, ran: () => ran };
  };

  const base = {
    cwd: CWD,
    clock: () => FIXED_NOW,
    logger: noopLogger,
  } as const;

  it('legacy single-script path is unchanged (one catch-all gate, success)', async () => {
    const { shell, ran } = scriptedShell({});
    const { run, rawOutput } = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates: normalizeVerifyGates('pnpm test', undefined),
      mode: 'fail-fast',
      runShellScript: shell,
    });
    expect(ran()).toEqual(['pnpm test']);
    expect(run.outcome).toBe('success');
    expect(run.command).toBe('pnpm test');
    // Single-gate run emits the bare output (no separator) — byte-for-byte the legacy log.
    expect(rawOutput).toBe('pnpm test-ok');
  });

  it('empty gate set → skipped row, never spawns the shell', async () => {
    const { shell, ran } = scriptedShell({});
    const { run, rawOutput } = await runVerifyGatesUseCase({
      ...base,
      phase: 'pre',
      gates: [],
      mode: 'all-run',
      runShellScript: shell,
    });
    expect(ran()).toEqual([]);
    expect(run.outcome).toBe('skipped');
    expect(run.command).toBe('');
    expect(rawOutput).toBe('');
  });

  it('multi-gate all-pass → success; command joins every executed gate; output concatenated with separators', async () => {
    const gates: readonly VerifyGate[] = [
      { pathPrefix: 'a', command: 'gate-a' },
      { pathPrefix: 'b', command: 'gate-b' },
    ];
    const { shell, ran } = scriptedShell({});
    const { run, rawOutput } = await runVerifyGatesUseCase({
      ...base,
      phase: 'pre',
      gates,
      mode: 'all-run',
      runShellScript: shell,
    });
    expect(ran()).toEqual(['gate-a', 'gate-b']);
    expect(run.outcome).toBe('success');
    expect(run.command).toBe('gate-a; gate-b');
    expect(rawOutput).toContain('── gate-a ──');
    expect(rawOutput).toContain('── gate-b ──');
  });

  it('fail-fast (post) stops at the first failing gate; command reports the culprit', async () => {
    const gates: readonly VerifyGate[] = [
      { pathPrefix: 'a', command: 'gate-a' },
      { pathPrefix: 'b', command: 'gate-b' },
      { pathPrefix: 'c', command: 'gate-c' },
    ];
    const { shell, ran } = scriptedShell({ 'gate-b': { passed: false, exitCode: 5, output: 'b broke' } });
    const { run } = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates,
      mode: 'fail-fast',
      runShellScript: shell,
    });
    // gate-c never runs — fail-fast stopped at gate-b.
    expect(ran()).toEqual(['gate-a', 'gate-b']);
    expect(run.outcome).toBe('failed');
    expect(run.command).toBe('gate-b');
    expect(run.exitCode).toBe(5);
  });

  it('all-run (pre) executes every gate despite an early failure; aggregate outcome stays failed', async () => {
    const gates: readonly VerifyGate[] = [
      { pathPrefix: 'a', command: 'gate-a' },
      { pathPrefix: 'b', command: 'gate-b' },
      { pathPrefix: 'c', command: 'gate-c' },
    ];
    const { shell, ran } = scriptedShell({ 'gate-a': { passed: false, exitCode: 3, output: 'a broke' } });
    const { run } = await runVerifyGatesUseCase({
      ...base,
      phase: 'pre',
      gates,
      mode: 'all-run',
      runShellScript: shell,
    });
    // Baseline needs the complete picture — every gate ran even though gate-a failed first.
    expect(ran()).toEqual(['gate-a', 'gate-b', 'gate-c']);
    expect(run.outcome).toBe('failed');
    // The FIRST failure decides the aggregate command/exit (gate-a).
    expect(run.command).toBe('gate-a');
    expect(run.exitCode).toBe(3);
  });

  it('scope filtering — a gate whose pathPrefix matches no touched path is skipped; catch-all always runs', async () => {
    const gates: readonly VerifyGate[] = [
      { pathPrefix: 'apps/web-ui', command: 'gate-web' },
      { pathPrefix: 'apps/api', command: 'gate-api' },
      { pathPrefix: '', command: 'gate-lint' },
    ];
    const { shell, ran } = scriptedShell({});
    const { run } = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates,
      scope: ['apps/web-ui/src/App.tsx'],
      mode: 'fail-fast',
      runShellScript: shell,
    });
    // Only the web-ui gate (prefix matches) + the catch-all run; the api gate is filtered out.
    expect(ran()).toEqual(['gate-web', 'gate-lint']);
    expect(run.outcome).toBe('success');
  });

  it('absent scope → ALL gates run (pre-verify / footprint fallback)', async () => {
    const gates: readonly VerifyGate[] = [
      { pathPrefix: 'apps/web-ui', command: 'gate-web' },
      { pathPrefix: 'apps/api', command: 'gate-api' },
    ];
    const { shell, ran } = scriptedShell({});
    await runVerifyGatesUseCase({ ...base, phase: 'pre', gates, mode: 'all-run', runShellScript: shell });
    expect(ran()).toEqual(['gate-web', 'gate-api']);
  });

  it('all gates filtered out by scope → skipped row (no spawn)', async () => {
    const gates: readonly VerifyGate[] = [{ pathPrefix: 'apps/api', command: 'gate-api' }];
    const { shell, ran } = scriptedShell({});
    const { run } = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates,
      scope: ['apps/web-ui/src/App.tsx'],
      mode: 'fail-fast',
      runShellScript: shell,
    });
    expect(ran()).toEqual([]);
    expect(run.outcome).toBe('skipped');
  });

  it('scope matching respects path-segment boundaries — prefix "src" does NOT match "src2/a.ts"', async () => {
    // Bare startsWith would run the 'src' gate against a 'src2/...' diff it never touched, failing
    // the attempt on an unrelated (possibly pre-existing-red) gate. The catch-all still always runs.
    const gates: readonly VerifyGate[] = [
      { pathPrefix: 'src', command: 'gate-src' },
      { pathPrefix: '', command: 'gate-lint' },
    ];
    const { shell, ran } = scriptedShell({});
    const { run } = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates,
      scope: ['src2/a.ts'],
      mode: 'fail-fast',
      runShellScript: shell,
    });
    expect(ran()).toEqual(['gate-lint']);
    expect(run.outcome).toBe('success');
  });

  it('scope matching includes a path on a segment boundary — prefix "src" matches "src/a.ts"', async () => {
    const gates: readonly VerifyGate[] = [{ pathPrefix: 'src', command: 'gate-src' }];
    const { shell, ran } = scriptedShell({});
    await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates,
      scope: ['src/a.ts'],
      mode: 'fail-fast',
      runShellScript: shell,
    });
    expect(ran()).toEqual(['gate-src']);
  });

  it('scope matching includes the prefix path itself — prefix "src/app" matches exactly "src/app"', async () => {
    const gates: readonly VerifyGate[] = [{ pathPrefix: 'src/app', command: 'gate-app' }];
    const { shell, ran } = scriptedShell({});
    await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates,
      scope: ['src/app'],
      mode: 'fail-fast',
      runShellScript: shell,
    });
    expect(ran()).toEqual(['gate-app']);
  });

  it('per-gate timeoutMs is threaded; falls back to defaultTimeoutMs when absent', async () => {
    const seen: Array<number | undefined> = [];
    const shell: Parameters<typeof runVerifyGatesUseCase>[0]['runShellScript'] = async (_cwd, _command, sopts) => {
      seen.push(sopts.timeoutMs);
      return Result.ok({ passed: true, exitCode: 0, output: '', durationMs: 1 });
    };
    const gates: readonly VerifyGate[] = [
      { pathPrefix: 'a', command: 'gate-a', timeoutMs: 1234 },
      { pathPrefix: 'b', command: 'gate-b' },
    ];
    await runVerifyGatesUseCase({
      ...base,
      phase: 'pre',
      gates,
      mode: 'all-run',
      defaultTimeoutMs: 9999,
      runShellScript: shell,
    });
    expect(seen).toEqual([1234, 9999]);
  });

  it('durationMs sums the executed gates', async () => {
    const gates: readonly VerifyGate[] = [
      { pathPrefix: 'a', command: 'gate-a' },
      { pathPrefix: 'b', command: 'gate-b' },
    ];
    const { shell } = scriptedShell({
      'gate-a': { passed: true, exitCode: 0, output: '', durationMs: 30 },
      'gate-b': { passed: true, exitCode: 0, output: '', durationMs: 70 },
    });
    const { run } = await runVerifyGatesUseCase({
      ...base,
      phase: 'pre',
      gates,
      mode: 'all-run',
      runShellScript: shell,
    });
    expect(run.durationMs).toBe(100);
  });

  it('spawn-error on a gate folds into spawn-error outcome with the spawn message', async () => {
    const gates: readonly VerifyGate[] = [{ pathPrefix: '', command: 'missing-binary' }];
    const shell: Parameters<typeof runVerifyGatesUseCase>[0]['runShellScript'] = async () =>
      Result.error(new StorageError({ subCode: 'io', message: 'spawn ENOENT: missing-binary' }));
    const { run, spawnErrorMessage } = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates,
      mode: 'fail-fast',
      runShellScript: shell,
    });
    expect(run.outcome).toBe('spawn-error');
    expect(run.exitCode).toBe(-1);
    expect(spawnErrorMessage).toContain('spawn ENOENT');
  });

  // Attribution composition: pre runs the FULL gate set (all-run), post runs a diff-scoped SUBSET
  // (fail-fast). Because the post subset ⊆ pre's full set, attribution per gate is like-vs-like —
  // a scoped red post on a green pre is `regressed`. This proves the aggregate outcomes feed the
  // existing `attributeVerify` truth table unchanged (HARNESS-PRINCIPLES § 9 deviation note).
  it('like-vs-like: green pre (all gates) + red scoped post → regressed via attributeVerify', async () => {
    const gates: readonly VerifyGate[] = [
      { pathPrefix: 'apps/web-ui', command: 'gate-web' },
      { pathPrefix: 'apps/api', command: 'gate-api' },
    ];
    // Pre: all gates green.
    const preShell = scriptedShell({});
    const pre = await runVerifyGatesUseCase({
      ...base,
      phase: 'pre',
      gates,
      mode: 'all-run',
      runShellScript: preShell.shell,
    });
    expect(pre.run.outcome).toBe('success');
    expect(preShell.ran()).toEqual(['gate-web', 'gate-api']);

    // Post: web-ui diff only → scoped to gate-web, which now fails.
    const postShell = scriptedShell({ 'gate-web': { passed: false, exitCode: 1, output: 'web broke' } });
    const post = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates,
      scope: ['apps/web-ui/src/App.tsx'],
      mode: 'fail-fast',
      runShellScript: postShell.shell,
    });
    expect(postShell.ran()).toEqual(['gate-web']);
    expect(post.run.outcome).toBe('failed');
    expect(attributeVerify(pre.run.outcome, post.run.outcome)).toBe('regressed');
  });
});

describe('runVerifyGatesUseCase — confirm-on-red re-run (confirmFailedGateOnce)', () => {
  type ShellStep =
    | {
        readonly passed: boolean;
        readonly exitCode: number | null;
        readonly output: string;
        readonly durationMs: number;
        readonly timedOut?: boolean;
      }
    | { readonly spawnError: string };

  // Per-command FIFO of results: each call to a command consumes the next scripted step, so a
  // test can make one gate red on its first run and green on the confirm re-run. A command with
  // no (remaining) steps passes.
  const sequencedShell = (
    plan: Readonly<Record<string, readonly ShellStep[]>>
  ): { shell: RunShellScript; calls: () => readonly string[] } => {
    const calls: string[] = [];
    const cursor = new Map<string, number>();
    const shell: RunShellScript = async (_cwd, command) => {
      calls.push(command);
      const i = cursor.get(command) ?? 0;
      cursor.set(command, i + 1);
      const step = plan[command]?.[i];
      if (step === undefined) return Result.ok({ passed: true, exitCode: 0, output: `${command}-ok`, durationMs: 10 });
      if ('spawnError' in step) return Result.error(new StorageError({ subCode: 'io', message: step.spawnError }));
      return Result.ok(step);
    };
    return { shell, calls: () => calls };
  };

  const base = { cwd: CWD, clock: () => FIXED_NOW, logger: noopLogger } as const;
  const red = (output: string, exitCode = 1, durationMs = 100): ShellStep => ({
    passed: false,
    exitCode,
    output,
    durationMs,
  });
  const green = (output: string, durationMs = 50): ShellStep => ({ passed: true, exitCode: 0, output, durationMs });
  // The gate leaves the tree as it found it — the precondition for a confirm re-run.
  const stableTree: ConfirmFailedGate = { treeFingerprint: async () => 'tree-a' };

  it('a red run that changed the tree fingerprint is NOT re-run — the red stands', async () => {
    const fingerprints = ['tree-a', 'tree-b'];
    const { shell, calls } = sequencedShell({ 'pnpm lint --fix': [red('fixed 3 files, 1 left', 1), green('ok')] });
    const out = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates: normalizeVerifyGates('pnpm lint --fix', undefined),
      mode: 'fail-fast',
      confirmFailedGateOnce: { treeFingerprint: async () => fingerprints.shift() },
      runShellScript: shell,
    });
    expect(calls()).toEqual(['pnpm lint --fix']);
    expect(out.run.outcome).toBe('failed');
    expect(out.run.exitCode).toBe(1);
    expect(out.run.flakyFailure).toBeUndefined();
    expect(out.rawOutput).not.toContain('confirm re-run');
    expect(attributeVerify('success', out.run.outcome)).toBe('regressed');
  });

  it('an unavailable tree fingerprint counts as changed — no confirm re-run', async () => {
    const { shell, calls } = sequencedShell({ 'pnpm test': [red('flake?'), green('ok')] });
    const out = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates: normalizeVerifyGates('pnpm test', undefined),
      mode: 'fail-fast',
      confirmFailedGateOnce: { treeFingerprint: async () => undefined },
      runShellScript: shell,
    });
    expect(calls()).toEqual(['pnpm test']);
    expect(out.run.outcome).toBe('failed');
  });

  it('red then green on the confirm re-run → success stamped with flakyFailure, both outputs, summed duration', async () => {
    const { shell, calls } = sequencedShell({ 'pnpm test': [red('flake!', 2, 100), green('all good', 50)] });
    const out = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates: normalizeVerifyGates('pnpm test', undefined),
      mode: 'fail-fast',
      confirmFailedGateOnce: stableTree,
      runShellScript: shell,
    });
    expect(calls()).toEqual(['pnpm test', 'pnpm test']);
    expect(out.run.outcome).toBe('success');
    expect(out.run.exitCode).toBe(0);
    expect(out.run.command).toBe('pnpm test');
    expect(out.run.flakyFailure).toEqual({ command: 'pnpm test', exitCode: 2 });
    expect(out.run.durationMs).toBe(150);
    expect(out.rawOutput).toContain('flake!');
    expect(out.rawOutput).toContain('── pnpm test (confirm re-run) ──');
    expect(out.rawOutput).toContain('all good');
    expect(out.rawOutput.indexOf('flake!')).toBeLessThan(out.rawOutput.indexOf('all good'));
  });

  it('red on both runs → failed with the FIRST exit code, and attributeVerify still says regressed', async () => {
    const { shell, calls } = sequencedShell({ 'pnpm test': [red('broke once', 3, 100), red('broke twice', 7, 40)] });
    const out = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates: normalizeVerifyGates('pnpm test', undefined),
      mode: 'fail-fast',
      confirmFailedGateOnce: stableTree,
      runShellScript: shell,
    });
    expect(calls()).toEqual(['pnpm test', 'pnpm test']);
    expect(out.run.outcome).toBe('failed');
    expect(out.run.exitCode).toBe(3);
    expect(out.run.command).toBe('pnpm test');
    expect(out.run.flakyFailure).toBeUndefined();
    expect(out.run.durationMs).toBe(140);
    expect(out.rawOutput).toContain('broke once');
    expect(out.rawOutput).toContain('── pnpm test (confirm re-run) ──');
    expect(out.rawOutput).toContain('broke twice');
    // The regression guard: a deterministic red still attributes as `regressed`.
    expect(attributeVerify('success', out.run.outcome)).toBe('regressed');
  });

  it('a timed-out red is NOT re-run (exactly one call)', async () => {
    const { shell, calls } = sequencedShell({
      'pnpm test': [
        { passed: false, exitCode: 143, output: '[timeout]', durationMs: 1000, timedOut: true },
        green('late'),
      ],
    });
    const out = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates: normalizeVerifyGates('pnpm test', undefined),
      mode: 'fail-fast',
      confirmFailedGateOnce: stableTree,
      runShellScript: shell,
    });
    expect(calls()).toEqual(['pnpm test']);
    expect(out.run.outcome).toBe('failed');
    expect(out.run.exitCode).toBe(143);
    expect(out.run.flakyFailure).toBeUndefined();
    expect(out.rawOutput).not.toContain('confirm re-run');
  });

  it('a null exit code (killed / child error) is NOT re-run', async () => {
    const { shell, calls } = sequencedShell({
      'pnpm test': [{ passed: false, exitCode: null, output: '[spawn error: x]', durationMs: 5 }, green('late')],
    });
    const out = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates: normalizeVerifyGates('pnpm test', undefined),
      mode: 'fail-fast',
      confirmFailedGateOnce: stableTree,
      runShellScript: shell,
    });
    expect(calls()).toEqual(['pnpm test']);
    expect(out.run.outcome).toBe('failed');
  });

  it('a spawn-error is NOT re-run (exactly one call)', async () => {
    const { shell, calls } = sequencedShell({ 'pnpm test': [{ spawnError: 'spawn ENOENT' }, green('late')] });
    const out = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates: normalizeVerifyGates('pnpm test', undefined),
      mode: 'fail-fast',
      confirmFailedGateOnce: stableTree,
      runShellScript: shell,
    });
    expect(calls()).toEqual(['pnpm test']);
    expect(out.run.outcome).toBe('spawn-error');
    expect(out.run.flakyFailure).toBeUndefined();
  });

  it('confirm off (default) → exactly one call per gate, a red stays red', async () => {
    const gates: readonly VerifyGate[] = [
      { pathPrefix: '', command: 'gate-1' },
      { pathPrefix: '', command: 'gate-2' },
    ];
    const { shell, calls } = sequencedShell({ 'gate-1': [red('nope'), green('would pass')] });
    const out = await runVerifyGatesUseCase({ ...base, phase: 'pre', gates, mode: 'all-run', runShellScript: shell });
    expect(calls()).toEqual(['gate-1', 'gate-2']);
    expect(out.run.outcome).toBe('failed');
    expect(out.run.command).toBe('gate-1');
  });

  it('fail-fast with gate 1 flaky → gates 2 and 3 still run, success carries gate 1 as flakyFailure', async () => {
    const gates: readonly VerifyGate[] = [
      { pathPrefix: '', command: 'gate-1' },
      { pathPrefix: '', command: 'gate-2' },
      { pathPrefix: '', command: 'gate-3' },
    ];
    const { shell, calls } = sequencedShell({ 'gate-1': [red('flake', 4), green('ok now')] });
    const out = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates,
      mode: 'fail-fast',
      confirmFailedGateOnce: stableTree,
      runShellScript: shell,
    });
    expect(calls()).toEqual(['gate-1', 'gate-1', 'gate-2', 'gate-3']);
    expect(out.run.outcome).toBe('success');
    expect(out.run.command).toBe('gate-1; gate-2; gate-3');
    expect(out.run.flakyFailure).toEqual({ command: 'gate-1', exitCode: 4 });
    expect(out.rawOutput).toContain('── gate-1 ──');
    expect(out.rawOutput).toContain('── gate-1 (confirm re-run) ──');
    expect(out.rawOutput).toContain('── gate-3 ──');
  });

  it('fail-fast: a flaky gate 1 then a deterministic red gate 2 → failed on gate 2, no flakyFailure on the row', async () => {
    const gates: readonly VerifyGate[] = [
      { pathPrefix: '', command: 'gate-1' },
      { pathPrefix: '', command: 'gate-2' },
      { pathPrefix: '', command: 'gate-3' },
    ];
    const { shell, calls } = sequencedShell({
      'gate-1': [red('flake', 4), green('ok')],
      'gate-2': [red('real', 9), red('real again', 9)],
    });
    const out = await runVerifyGatesUseCase({
      ...base,
      phase: 'post',
      gates,
      mode: 'fail-fast',
      confirmFailedGateOnce: stableTree,
      runShellScript: shell,
    });
    expect(calls()).toEqual(['gate-1', 'gate-1', 'gate-2', 'gate-2']);
    expect(out.run.outcome).toBe('failed');
    expect(out.run.command).toBe('gate-2');
    expect(out.run.exitCode).toBe(9);
  });
});
