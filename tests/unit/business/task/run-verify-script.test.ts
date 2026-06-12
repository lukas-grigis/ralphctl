import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { absolutePath, FIXED_NOW } from '@tests/fixtures/domain.ts';
import {
  attributeVerify,
  normalizeVerifyGates,
  runVerifyGatesUseCase,
  runVerifyScriptUseCase,
} from '@src/business/task/run-verify-script.ts';
import type { VerifyGate } from '@src/domain/entity/repository.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/** Local scale constant used to build deliberately large output fixtures (audit-[03]: no
 *  persistence-time cap on rawOutput; the test asserts verbatim round-trip). */
const HUGE_OUTPUT_BYTES = 4096;

const CWD = absolutePath('/tmp/repo');

const passingShell: Parameters<typeof runVerifyScriptUseCase>[0]['runShellScript'] = async () =>
  Result.ok({ passed: true, exitCode: 0, output: 'OK', durationMs: 100 });

const spawnErrorShell: Parameters<typeof runVerifyScriptUseCase>[0]['runShellScript'] = async () =>
  Result.error(new StorageError({ subCode: 'io', message: 'spawn ENOENT: command not found' }));

describe('runVerifyScriptUseCase', () => {
  it('returns outcome="skipped" when no script configured', async () => {
    const { run, rawOutput } = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'pre',
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
    const { run } = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'pre',
      verifyScript: '   \n\t ',
      clock: () => FIXED_NOW,
      runShellScript: passingShell,
      logger: noopLogger,
    });
    expect(run.outcome).toBe('skipped');
  });

  it('returns outcome="success" with rawOutput when script exits 0 (audit row carries no body)', async () => {
    const { run, rawOutput } = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'post',
      verifyScript: 'pnpm test',
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
    const { run, rawOutput } = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'post',
      verifyScript: 'pnpm test',
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
    const { run, rawOutput, spawnErrorMessage } = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'pre',
      verifyScript: 'missing-binary',
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
    await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'pre',
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
