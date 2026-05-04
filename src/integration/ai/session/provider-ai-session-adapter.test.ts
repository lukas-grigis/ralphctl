import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimitError } from '@src/domain/errors/rate-limit-error.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SessionOptions } from '@src/business/ports/ai-session-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import { FakeProcessRunner } from '@src/integration/_test-fakes/fake-process-runner.ts';
import { claudeAdapter } from '@src/integration/ai/providers/claude-adapter.ts';
import { copilotAdapter } from '@src/integration/ai/providers/copilot-adapter.ts';
import { ProviderAiSessionAdapter } from './provider-ai-session-adapter.ts';

const cwd = AbsolutePath.trustString('/tmp/ralphctl-session-adapter');

const baseOptions = (): SessionOptions => ({ cwd });

describe('ProviderAiSessionAdapter — readiness', () => {
  it('throws synchronously when sync getters are called before ensureReady', () => {
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: new FakeProcessRunner(),
    });
    expect(() => adapter.getProviderName()).toThrow(/not ready/);
    expect(() => adapter.getProviderDisplayName()).toThrow(/not ready/);
    expect(() => adapter.getSpawnEnv()).toThrow(/not ready/);
  });

  it('ensureReady is idempotent (only resolves provider once)', async () => {
    const getProvider = vi.fn(() => Promise.resolve('claude' as const));
    const adapter = new ProviderAiSessionAdapter({
      getProvider,
      process: new FakeProcessRunner(),
    });
    await adapter.ensureReady();
    await adapter.ensureReady();
    await adapter.ensureReady();
    expect(getProvider).toHaveBeenCalledTimes(1);
  });

  it('exposes provider metadata after ensureReady', async () => {
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: new FakeProcessRunner(),
    });
    await adapter.ensureReady();
    expect(adapter.getProviderName()).toBe('claude');
    expect(adapter.getProviderDisplayName()).toBe('Claude');
    expect(adapter.getSpawnEnv()).toHaveProperty('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD', '1');
  });

  it('accepts a literal ProviderAdapter from getProvider (test seam)', async () => {
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve(copilotAdapter),
      process: new FakeProcessRunner(),
    });
    await adapter.ensureReady();
    expect(adapter.getProviderName()).toBe('copilot');
  });
});

describe('ProviderAiSessionAdapter.spawnHeadless', () => {
  it('runs through the session runner and returns SessionResult', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'sx', model: 'm' }),
    });
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
    });
    const r = await adapter.spawnHeadless('do thing', baseOptions());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.output).toBe('ok');
      expect(r.value.sessionId).toBe('sx');
    }
  });

  it('forwards args, env, and resumeSessionId to the runner', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok' }),
    });
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve(claudeAdapter),
      process: proc,
    });
    await adapter.spawnHeadless('p', {
      cwd,
      args: ['--verbose'],
      env: { CUSTOM_KEY: 'v' },
      resumeSessionId: 'sess-y',
    });
    const call = proc.lastCall();
    expect(call?.args).toContain('--verbose');
    expect(call?.args).toContain('--resume');
    expect(call?.args).toContain('sess-y');
    expect(call?.options.env?.['CUSTOM_KEY']).toBe('v');
  });

  it('propagates RateLimitError without retrying', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stderr: 'rate limit exceeded',
      exitCode: 1,
    });
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
    });
    const r = await adapter.spawnHeadless('p', baseOptions());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(RateLimitError);
  });
});

describe('ProviderAiSessionAdapter.resumeSession', () => {
  it('passes the session id through to the headless spawn', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'r', session_id: 'still-here' }),
    });
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
    });
    const r = await adapter.resumeSession('prior-sess', 'p', baseOptions());
    expect(r.ok).toBe(true);
    expect(proc.lastCall()?.args).toContain('prior-sess');
  });
});

describe('ProviderAiSessionAdapter.spawnWithRetry', () => {
  it('returns immediately on first-attempt success', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok' }),
    });
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
      sleep: () => Promise.resolve(),
    });
    const r = await adapter.spawnWithRetry('p', baseOptions());
    expect(r.ok).toBe(true);
    expect(proc.calls.length).toBe(1);
  });

  it('retries once on rate limit and succeeds', async () => {
    const proc = new FakeProcessRunner()
      .enqueue({
        stderr: 'rate limit. retry-after: 5',
        stdout: JSON.stringify({ result: 'partial', session_id: 'rl-sess' }),
        exitCode: 1,
      })
      .enqueue({ stdout: JSON.stringify({ result: 'final' }) });

    const sleeps: number[] = [];
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    const r = await adapter.spawnWithRetry('p', baseOptions());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.output).toBe('final');
    expect(proc.calls.length).toBe(2);
    expect(sleeps).toStrictEqual([5_000]);
    // Second call should resume using the captured session id.
    expect(proc.calls[1]?.args).toContain('rl-sess');
  });

  it('fires rateLimitListener.onPaused with resumeAt before sleeping and onResumed after', async () => {
    const proc = new FakeProcessRunner()
      .enqueue({
        stderr: 'rate limit exceeded. retry-after: 30',
        exitCode: 1,
      })
      .enqueue({ stdout: JSON.stringify({ result: 'final' }) });

    const calls: { phase: 'paused' | 'resumed'; reason?: string; resumeAt?: Date }[] = [];
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
      sleep: () => Promise.resolve(),
      rateLimitListener: {
        onPaused(reason, resumeAt) {
          calls.push({ phase: 'paused', reason, ...(resumeAt ? { resumeAt } : {}) });
        },
        onResumed() {
          calls.push({ phase: 'resumed' });
        },
      },
    });

    const r = await adapter.spawnWithRetry('p', baseOptions());
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.phase)).toStrictEqual(['paused', 'resumed']);
    expect(calls[0]?.reason).toMatch(/rate-limited/i);
    expect(calls[0]?.resumeAt).toBeInstanceOf(Date);
  });

  it('uses default retry-after when the upstream supplies none', async () => {
    const proc = new FakeProcessRunner()
      .enqueue({ stderr: 'rate limit exceeded', exitCode: 1 })
      .enqueue({ stdout: JSON.stringify({ result: 'final' }) });

    const sleeps: number[] = [];
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    const r = await adapter.spawnWithRetry('p', baseOptions());
    expect(r.ok).toBe(true);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('surfaces the last RateLimitError when retries are exhausted', async () => {
    const proc = new FakeProcessRunner()
      .enqueue({ stderr: 'rate limit', exitCode: 1 })
      .enqueue({ stderr: 'rate limit again', exitCode: 1 });

    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
      sleep: () => Promise.resolve(),
    });

    const r = await adapter.spawnWithRetry('p', { ...baseOptions(), maxRetries: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(RateLimitError);
    expect(proc.calls.length).toBe(2);
  });

  it('does not retry on non-rate-limit failures', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stderr: 'segfault',
      exitCode: 139,
    });
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
      sleep: () => Promise.resolve(),
    });
    const r = await adapter.spawnWithRetry('p', { ...baseOptions(), maxRetries: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(StorageError);
    expect(proc.calls.length).toBe(1);
  });

  it('aborts before sleeping when the caller cancels', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stderr: 'rate limit',
      exitCode: 1,
    });
    const ctrl = new AbortController();
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
      sleep: async (ms) => {
        // Abort during the sleep so the next loop iteration short-circuits.
        ctrl.abort();
        await new Promise((r) => setTimeout(r, ms === 0 ? 0 : 1));
      },
    });
    const r = await adapter.spawnWithRetry('p', {
      ...baseOptions(),
      abortSignal: ctrl.signal,
      maxRetries: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(StorageError);
      expect(r.error.message).toMatch(/abort/);
    }
    // Single spawn attempt — second iteration cancels before re-spawn.
    expect(proc.calls.length).toBe(1);
  });
});

describe('ProviderAiSessionAdapter — session.md audit', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `ralphctl-session-md-adapter-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function silentLogger(): LoggerPort & { warns: { msg: string; ctx?: unknown }[] } {
    const warns: { msg: string; ctx?: unknown }[] = [];
    const noop = (): void => undefined;
    const stub: LoggerPort & { warns: typeof warns } = {
      warns,
      log: noop,
      debug: noop,
      info: noop,
      success: noop,
      warn: (msg, ctx) => warns.push({ msg, ctx }),
      error: noop,
      child: () => stub,
      time: () => noop,
    };
    return stub;
  }

  it('writes a session.md start record before headless spawn (provider, cwd, flags, prompt body)', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'sess-x', model: 'claude-opus-4-7' }),
    });
    const path = join(dir, 'session.md');
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
    });
    const r = await adapter.spawnHeadless('hello agent', {
      cwd: AbsolutePath.trustString(dir),
      sessionMdPath: AbsolutePath.trustString(path),
    });
    expect(r.ok).toBe(true);
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('provider: claude');
    expect(body).toContain(`cwd: ${dir}`);
    expect(body).toMatch(/flags: \[/);
    // Headless flags include `-p` and the JSON output mode marker.
    expect(body).toContain('-p');
    expect(body).toContain('--output-format');
    expect(body).toContain('## Prompt\n\nhello agent');
  });

  it('rewrites the session.md frontmatter with model + sessionId + exitCode after headless success', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'sess-final', model: 'claude-opus-4-7' }),
    });
    const path = join(dir, 'session.md');
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
    });
    const r = await adapter.spawnHeadless('hello', {
      cwd: AbsolutePath.trustString(dir),
      sessionMdPath: AbsolutePath.trustString(path),
    });
    expect(r.ok).toBe(true);
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('finished:');
    expect(body).toContain('exitCode: 0');
    expect(body).toContain('sessionId: sess-final');
    expect(body).toContain('model: claude-opus-4-7');
    // Prompt body preserved across the start → finish round trip.
    expect(body).toContain('## Prompt\n\nhello');
  });

  it('records exitCode 1 on a non-zero spawn but still writes session.md', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stderr: 'segfault',
      exitCode: 139,
    });
    const path = join(dir, 'session.md');
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
    });
    const r = await adapter.spawnHeadless('go', {
      cwd: AbsolutePath.trustString(dir),
      sessionMdPath: AbsolutePath.trustString(path),
    });
    expect(r.ok).toBe(false);
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('exitCode: 1');
    expect(body).toContain('## Prompt\n\ngo');
  });

  it('logs a warn but does not fail the spawn when session.md write fails', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok' }),
    });
    const logger = silentLogger();
    // Path is inside a directory we never create — but writeSessionStart
    // calls mkdir(recursive) so it succeeds. Force a failure by pointing
    // at a path under an existing FILE (not dir).
    const blockerFile = join(dir, 'blocker');
    await (await import('node:fs/promises')).writeFile(blockerFile, 'block');
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
      logger,
    });
    const r = await adapter.spawnHeadless('go', {
      cwd: AbsolutePath.trustString(dir),
      sessionMdPath: AbsolutePath.trustString(join(blockerFile, 'session.md')),
    });
    expect(r.ok).toBe(true);
    // Adapter never throws on audit failure; the warn surfaces it.
    expect(logger.warns.some((w) => w.msg.includes('failed to write session.md'))).toBe(true);
  });

  it('omits session.md writes entirely when sessionMdPath is not provided', async () => {
    const proc = new FakeProcessRunner().enqueue({ stdout: JSON.stringify({ result: 'ok' }) });
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve('claude'),
      process: proc,
    });
    const r = await adapter.spawnHeadless('p', { cwd: AbsolutePath.trustString(dir) });
    expect(r.ok).toBe(true);
    const path = join(dir, 'session.md');
    await expect(readFile(path, 'utf-8')).rejects.toThrow();
  });

  it('records the resume session id in flags when resuming a prior session', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'sess-y' }),
    });
    const path = join(dir, 'session.md');
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve(claudeAdapter),
      process: proc,
    });
    const r = await adapter.resumeSession('00000000-0000-0000-0000-000000000001', 'p', {
      cwd: AbsolutePath.trustString(dir),
      sessionMdPath: AbsolutePath.trustString(path),
    });
    expect(r.ok).toBe(true);
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('--resume');
    expect(body).toContain('00000000-0000-0000-0000-000000000001');
  });

  it('captures the sessionId at start when resumeSessionId is provided', async () => {
    const proc = new FakeProcessRunner().enqueue({ stdout: JSON.stringify({ result: 'ok' }) });
    const path = join(dir, 'session.md');
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve(claudeAdapter),
      process: proc,
    });
    const r = await adapter.spawnHeadless('p', {
      cwd: AbsolutePath.trustString(dir),
      sessionMdPath: AbsolutePath.trustString(path),
      resumeSessionId: '00000000-0000-0000-0000-000000000002',
    });
    expect(r.ok).toBe(true);
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('sessionId: 00000000-0000-0000-0000-000000000002');
  });

  // Sanity check that the copilot path goes through the same audit
  // hook — provider-specific flag rendering is delegated to the
  // adapter, so this test just asserts the file appears.
  it('writes session.md for the copilot provider', async () => {
    const proc = new FakeProcessRunner().enqueue({ stdout: '' });
    const path = join(dir, 'session.md');
    const adapter = new ProviderAiSessionAdapter({
      getProvider: () => Promise.resolve(copilotAdapter),
      process: proc,
    });
    await adapter.spawnHeadless('p', {
      cwd: AbsolutePath.trustString(dir),
      sessionMdPath: AbsolutePath.trustString(path),
    });
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('provider: copilot');
    expect(body).toContain('## Prompt\n\np');
  });
});
