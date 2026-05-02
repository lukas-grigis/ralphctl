import { describe, expect, it } from 'vitest';

import { RateLimitError } from '@src/domain/errors/rate-limit-error.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { FakeProcessRunner } from '@src/integration/_test-fakes/fake-process-runner.ts';
import { claudeAdapter } from '@src/integration/ai/providers/claude-adapter.ts';
import { copilotAdapter } from '@src/integration/ai/providers/copilot-adapter.ts';
import { SessionRunner } from './session-runner.ts';

const cwd = AbsolutePath.trustString('/tmp/ralphctl-session-runner');

describe('SessionRunner.runHeadless', () => {
  it('returns parsed output on a clean exit', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'sess-1', model: 'opus' }),
      exitCode: 0,
    });
    const runner = new SessionRunner(claudeAdapter, proc);
    const r = await runner.runHeadless({ prompt: 'do thing', cwd });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.output).toBe('ok');
      expect(r.value.sessionId).toBe('sess-1');
      expect(r.value.model).toBe('opus');
    }
  });

  it('passes prompt as stdin to the child', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok', session_id: 's' }),
    });
    const runner = new SessionRunner(claudeAdapter, proc);
    await runner.runHeadless({ prompt: 'hello there', cwd });
    expect(proc.lastCall()?.options.stdin).toBe('hello there');
  });

  it('builds claude headless args correctly', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok' }),
    });
    const runner = new SessionRunner(claudeAdapter, proc);
    await runner.runHeadless({ prompt: 'p', cwd });
    const call = proc.lastCall();
    expect(call?.command).toBe('claude');
    expect(call?.args[0]).toBe('-p');
    expect(call?.args).toContain('bypassPermissions');
  });

  it('builds copilot headless args correctly', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok' }),
    });
    const runner = new SessionRunner(copilotAdapter, proc);
    await runner.runHeadless({ prompt: 'p', cwd });
    const call = proc.lastCall();
    expect(call?.command).toBe('copilot');
    expect(call?.args).toContain('--allow-all-tools');
    expect(call?.args).toContain('--share');
  });

  it('inserts resume args when resumeSessionId is set', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok' }),
    });
    const runner = new SessionRunner(claudeAdapter, proc);
    await runner.runHeadless({ prompt: 'p', cwd, resumeSessionId: 'sess-x' });
    const call = proc.lastCall();
    expect(call?.args).toContain('--resume');
    expect(call?.args).toContain('sess-x');
  });

  it('returns StorageError when resumeSessionId is malformed', async () => {
    const proc = new FakeProcessRunner();
    const runner = new SessionRunner(claudeAdapter, proc);
    const r = await runner.runHeadless({
      prompt: 'p',
      cwd,
      resumeSessionId: '--evil',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(StorageError);
      expect((r.error as StorageError).subCode).toBe('io');
    }
    // No spawn happened — the validation runs before run().
    expect(proc.calls.length).toBe(0);
  });

  it('merges adapter env, caller env, and supplies them to the runner', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok' }),
    });
    const runner = new SessionRunner(claudeAdapter, proc);
    await runner.runHeadless({
      prompt: 'p',
      cwd,
      env: { RALPHCTL_TEST: 'caller-set' },
    });
    const env = proc.lastCall()?.options.env;
    expect(env?.['CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD']).toBe('1');
    expect(env?.['RALPHCTL_TEST']).toBe('caller-set');
  });

  it('lets the caller env override adapter env on key collision', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok' }),
    });
    const runner = new SessionRunner(claudeAdapter, proc);
    await runner.runHeadless({
      prompt: 'p',
      cwd,
      env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0' },
    });
    expect(proc.lastCall()?.options.env?.['CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD']).toBe('0');
  });

  it('forwards the abort signal to the process runner', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'ok' }),
    });
    const runner = new SessionRunner(claudeAdapter, proc);
    const ctrl = new AbortController();
    await runner.runHeadless({ prompt: 'p', cwd, abortSignal: ctrl.signal });
    expect(proc.lastCall()?.options.abortSignal).toBe(ctrl.signal);
  });

  it('returns RateLimitError when stderr matches and exit is non-zero', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: '',
      stderr: 'rate limit exceeded. retry-after: 30',
      exitCode: 1,
    });
    const runner = new SessionRunner(claudeAdapter, proc);
    const r = await runner.runHeadless({ prompt: 'p', cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(RateLimitError);
      expect((r.error as RateLimitError).subCode).toBe('spawn-exit');
      expect((r.error as RateLimitError).retryAfterMs).toBe(30_000);
    }
  });

  it('captures session id on rate-limit when JSON output exposes one', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: JSON.stringify({ result: 'partial', session_id: 'rl-sess' }),
      stderr: '429 Too Many Requests',
      exitCode: 1,
    });
    const runner = new SessionRunner(claudeAdapter, proc);
    const r = await runner.runHeadless({ prompt: 'p', cwd });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error instanceof RateLimitError) {
      expect(r.error.sessionId).toBe('rl-sess');
    }
  });

  it('returns StorageError on a non-zero exit without a rate-limit pattern', async () => {
    const proc = new FakeProcessRunner().enqueue({
      stdout: '',
      stderr: 'segmentation fault',
      exitCode: 139,
    });
    const runner = new SessionRunner(claudeAdapter, proc);
    const r = await runner.runHeadless({ prompt: 'p', cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(StorageError);
      expect((r.error as StorageError).subCode).toBe('io');
      expect(r.error.message).toContain('139');
    }
  });

  it('rejects prompts that exceed the size cap', async () => {
    const proc = new FakeProcessRunner();
    const runner = new SessionRunner(claudeAdapter, proc);
    const r = await runner.runHeadless({
      prompt: 'a'.repeat(1_000_001),
      cwd,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(StorageError);
      expect(r.error.message).toMatch(/maximum size/);
    }
    expect(proc.calls.length).toBe(0);
  });

  it('propagates a process-runner spawn failure verbatim', async () => {
    const proc = new FakeProcessRunner().enqueueError(new StorageError({ subCode: 'io', message: 'binary not found' }));
    const runner = new SessionRunner(claudeAdapter, proc);
    const r = await runner.runHeadless({ prompt: 'p', cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(StorageError);
      expect(r.error.message).toBe('binary not found');
    }
  });
});
