import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import { FULL_AUTO, READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { GROK_MODELS } from '@src/domain/value/settings-models/grok.ts';
import { buildGrokArgs, createGrokProvider } from '@src/integration/ai/providers/grok/headless.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import type { TokenUsageEvent } from '@src/business/observability/events.ts';

interface FakeChildScript {
  readonly stdoutChunks?: readonly string[];
  /** Emitted after `exit` and before `close` — proves `resolveOn: 'close'` keeps a late `end`. */
  readonly stdoutAfterExit?: readonly string[];
  readonly stderrChunks?: readonly string[];
  readonly exitCode?: number | null;
  readonly exitSignal?: NodeJS.Signals | null;
  readonly hang?: boolean;
}

const makeStream = (): EventEmitter & { setEncoding: (e: string) => void } => {
  const ee = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  ee.setEncoding = (): void => {};
  return ee;
};

const makeFakeChild = (script: FakeChildScript): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { _killed: boolean };
  const stdout = makeStream();
  const stderr = makeStream();
  const stdin = {
    end(_data?: unknown): void {
      void _data;
    },
  };
  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    kill(): boolean {
      child._killed = true;
      setTimeout(() => {
        child.emit('exit', null, 'SIGTERM');
        setTimeout(() => child.emit('close', null, 'SIGTERM'), 0);
      }, 0);
      return true;
    },
    _killed: false,
  });
  setTimeout(() => {
    for (const chunk of script.stdoutChunks ?? []) stdout.emit('data', chunk);
    for (const chunk of script.stderrChunks ?? []) stderr.emit('data', chunk);
    if (script.hang === true) return;
    setTimeout(() => {
      const code = script.exitCode ?? 0;
      const signal = script.exitSignal ?? null;
      child.emit('exit', code, signal);
      setTimeout(() => {
        for (const chunk of script.stdoutAfterExit ?? []) stdout.emit('data', chunk);
        child.emit('close', code, signal);
      }, 0);
    }, 0);
  }, 0);
  return child;
};

interface CapturingSpawnState {
  readonly spawn: ProviderSpawn;
  readonly calls: ReadonlyArray<{
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
  }>;
}

const makeSpawn = (scripts: readonly FakeChildScript[]): CapturingSpawnState => {
  let i = 0;
  const calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
  const spawn: ProviderSpawn = (command, args, options) => {
    calls.push({ command, args, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) });
    const script = scripts[i] ?? scripts[scripts.length - 1] ?? {};
    i++;
    return makeFakeChild(script);
  };
  return { spawn, calls };
};

const PROMPT = 'rendered prompt body' as unknown as Prompt;
const CWD = absolutePath('/tmp/grok-provider-test');
const END_LINE = JSON.stringify({
  type: 'end',
  stopReason: 'end_turn',
  sessionId: '01a047e3-cfea-7b83-8047-31c8c2a39cc8',
  usage: { input_tokens: 12, output_tokens: 4 },
});

let signalsCounter = 0;
const tempSignalsFile = () => {
  signalsCounter += 1;
  return absolutePath(
    join(
      tmpdir(),
      `ralphctl-grok-test-${String(process.pid)}-${String(Date.now())}-${String(signalsCounter)}`,
      'signals.json'
    )
  );
};

const session = (overrides: Partial<AiSession> = {}): AiSession => ({
  prompt: PROMPT,
  cwd: CWD,
  model: GROK_MODELS[0]!,
  permissions: READ_ONLY,
  signalsFile: tempSignalsFile(),
  ...overrides,
});

const PROMPT_FILE = '/tmp/grok-prompt.md';

const unwrapArgs = (s: AiSession, promptFile: string = PROMPT_FILE): readonly string[] => {
  const r = buildGrokArgs(s, promptFile);
  if (!r.ok) throw new Error(`buildGrokArgs failed: ${r.error.message}`);
  return r.value;
};

describe('createGrokProvider', () => {
  it('writes grok-prompt.md, passes --prompt-file, and keeps the body out of argv', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn, calls } = makeSpawn([{ stdoutChunks: [`${END_LINE}\n`], exitCode: 0 }]);
    const provider = createGrokProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    const promptFile = join(dirname(String(sess.signalsFile)), 'grok-prompt.md');
    await expect(fs.readFile(promptFile, 'utf8')).resolves.toBe(PROMPT as unknown as string);

    const args = calls[0]!.args;
    expect(args).toContain('--prompt-file');
    expect(args).toContain(promptFile);
    expect(args).toContain('--output-format');
    expect(args).toContain('streaming-json');
    expect(args).toContain('--always-approve');
    expect(args).toContain('--no-auto-update');
    expect(args).toContain('-m');
    expect(args).toContain(GROK_MODELS[0]!);
    expect(args).toContain('--cwd');
    expect(args).toContain(String(CWD));
    expect(args).not.toContain(PROMPT as unknown as string);
    const sandboxIdx = args.indexOf('--sandbox');
    expect(sandboxIdx).toBeGreaterThanOrEqual(0);
    expect(args[sandboxIdx + 1]).toBe('off');
    expect(args).not.toContain('-p');
    expect(calls[0]!.command).toBe('grok');
  });

  it('captures session id from the end.sessionId line', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeSpawn([
      {
        stdoutChunks: ['{"type":"text","data":"ping"}\n', `${END_LINE}\n`],
        exitCode: 0,
      },
    ]);
    const provider = createGrokProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.sessionId).toBe('01a047e3-cfea-7b83-8047-31c8c2a39cc8');
  });

  it('waits for close so a late end.sessionId after exit is kept', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeSpawn([
      {
        stdoutChunks: ['{"type":"text","data":"ping"}\n'],
        stdoutAfterExit: [`${END_LINE}\n`],
        exitCode: 0,
      },
    ]);
    const provider = createGrokProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.sessionId).toBe('01a047e3-cfea-7b83-8047-31c8c2a39cc8');
  });

  it('fails the spawn when grok-prompt.md cannot be written — never inlines -p', async () => {
    const cap = createCapturingBus();
    const { spawn, calls } = makeSpawn([{ exitCode: 0, stdoutChunks: [`${END_LINE}\n`] }]);
    const provider = createGrokProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const blocker = join(tmpdir(), `ralphctl-grok-not-a-dir-${String(process.pid)}-${String(Date.now())}`);
    await fs.writeFile(blocker, 'not a directory');
    try {
      const out = await provider.generate(session({ signalsFile: absolutePath(join(blocker, 'signals.json')) }));
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.error.code).toBe('storage-error');
      expect(calls).toHaveLength(0);
    } finally {
      await fs.unlink(blocker);
    }
  });
});

describe('buildGrokArgs — AiSession → CLI flag translation', () => {
  it('rejects an unknown model with InvalidStateError', () => {
    const r = buildGrokArgs(session({ model: 'gpt-5.5' }), PROMPT_FILE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'gpt-5.5'");
    expect(r.error.message).toContain('Grok model');
  });

  it('forwards effort as --effort <level>', () => {
    const args = unwrapArgs(session({ effort: 'xhigh' }));
    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('xhigh');
  });

  it('forwards resume as -r <id>', () => {
    const id = 'sess-abc' as unknown as SessionId;
    const args = unwrapArgs(session({ resume: id }));
    const idx = args.indexOf('-r');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('sess-abc');
  });

  it('READ_ONLY includes --disallowed-tools with search_replace and run_terminal_command', () => {
    const args = unwrapArgs(session({ permissions: READ_ONLY }));
    expect(args).toContain('--always-approve');
    const idx = args.indexOf('--disallowed-tools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('search_replace,run_terminal_command,run_terminal_cmd');
    expect(args).toContain('--no-subagents');
  });

  it('FULL_AUTO does not include --disallowed-tools', () => {
    const args = unwrapArgs(session({ permissions: FULL_AUTO }));
    expect(args).toContain('--always-approve');
    expect(args).not.toContain('--disallowed-tools');
    expect(args).not.toContain('--no-subagents');
  });

  it('forces --sandbox off and never emits --permission-mode (plan would block signals.json)', () => {
    for (const permissions of [FULL_AUTO, READ_ONLY]) {
      const args = unwrapArgs(session({ permissions }));
      const sandboxIdx = args.indexOf('--sandbox');
      expect(sandboxIdx).toBeGreaterThanOrEqual(0);
      expect(args[sandboxIdx + 1]).toBe('off');
      expect(args).not.toContain('--permission-mode');
      expect(args).not.toContain('plan');
    }
  });

  it('denies only the closed gates — shell-off keeps search_replace, network-off keeps shell', () => {
    const shellOff = unwrapArgs(
      session({
        permissions: { autoApprove: true, canModifyRepoFiles: true, canRunShell: false, canAccessNetwork: true },
      })
    );
    const shellDenied = shellOff[shellOff.indexOf('--disallowed-tools') + 1];
    expect(shellDenied).toBe('run_terminal_command,run_terminal_cmd');
    expect(shellOff).toContain('--no-subagents');

    const networkOff = unwrapArgs(
      session({
        permissions: { autoApprove: true, canModifyRepoFiles: false, canRunShell: true, canAccessNetwork: false },
      })
    );
    const networkDenied = networkOff[networkOff.indexOf('--disallowed-tools') + 1];
    expect(networkDenied).toBe('search_replace,web_search,web_fetch');
    expect(networkDenied).not.toMatch(/run_terminal_command/);
    expect(networkOff).toContain('--no-subagents');
  });

  it('READ_ONLY denylist does not include write — signals.json lands through it', () => {
    const args = unwrapArgs(session({ permissions: READ_ONLY }));
    const idx = args.indexOf('--disallowed-tools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).not.toMatch(/\bwrite\b/);
  });
});

describe('createGrokProvider — TokenUsageEvent emission', () => {
  it('emits one TokenUsageEvent on clean exit with usage from the end record', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const end = JSON.stringify({
      type: 'end',
      stopReason: 'end_turn',
      sessionId: '01a047e3-cfea-7b83-8047-31c8c2a39cc8',
      usage: {
        input_tokens: 1234,
        output_tokens: 567,
        cache_read_input_tokens: 89,
        cache_creation_input_tokens: 12,
      },
    });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${end}\n`], exitCode: 0 }]);
    const provider = createGrokProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    const tokenEvents = cap.events.filter((e): e is TokenUsageEvent => e.type === 'token-usage');
    expect(tokenEvents).toHaveLength(1);
    const evt = tokenEvents[0]!;
    expect(evt.provider).toBe('xai-grok');
    expect(evt.sessionId).toBe('01a047e3-cfea-7b83-8047-31c8c2a39cc8');
    expect(evt.model).toBe(GROK_MODELS[0]);
    expect(evt.inputTokens).toBe(1234);
    expect(evt.outputTokens).toBe(567);
    expect(evt.cacheReadTokens).toBe(89);
    expect(evt.cacheCreationTokens).toBe(12);
    expect(evt.contextWindow).toBe(500_000);

    if (!out.ok) return;
    expect(out.value.usage?.inputTokens).toBe(1234);
    expect(out.value.usage?.outputTokens).toBe(567);
  });

  it('does NOT emit a TokenUsageEvent on spawn failure (non-zero exit)', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeSpawn([{ stdoutChunks: [`${END_LINE}\n`], stderrChunks: ['boom\n'], exitCode: 2 }]);
    const provider = createGrokProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(session());
    expect(out.ok).toBe(false);
    expect(cap.events.filter((e) => e.type === 'token-usage')).toHaveLength(0);
  });
});

describe('createGrokProvider — retry and stream errors', () => {
  it('rate-limit on a stdout error record (empty stderr) retries via -r <id>', async () => {
    const cap = createCapturingBus();
    const { spawn, calls } = makeSpawn([
      {
        stdoutChunks: [`{"type":"error","message":"rate limit exceeded"}\n`, `${END_LINE}\n`],
        exitCode: 1,
      },
      { stdoutChunks: [`${END_LINE}\n`], exitCode: 0 },
    ]);
    const provider = createGrokProvider({
      rateLimitRetries: 2,
      eventBus: cap.bus,
      spawn,
      backoffSchedule: [0, 0, 0],
    });
    const out = await provider.generate(session());
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).not.toContain('-r');
    const idx = calls[1]!.args.indexOf('-r');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(calls[1]!.args[idx + 1]).toBe('01a047e3-cfea-7b83-8047-31c8c2a39cc8');
  });

  it('abort during rate-limit backoff: surfaces AbortError (not InvalidStateError)', async () => {
    const cap = createCapturingBus();
    const controller = new AbortController();
    let n = 0;
    const spawn: ProviderSpawn = () => {
      n += 1;
      setTimeout(() => controller.abort(), 5);
      return makeFakeChild({ stderrChunks: ['Error: rate limit exceeded\n'], exitCode: 1 });
    };
    const provider = createGrokProvider({
      rateLimitRetries: 2,
      eventBus: cap.bus,
      spawn,
      backoffSchedule: [5_000, 5_000, 5_000],
    });
    const out = await provider.generate(session({ abortSignal: controller.signal }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('aborted');
    expect(out.error.name).toBe('AbortError');
    expect(n).toBe(1);
  });

  it('non-zero exit (code 143) with signals.json present recovers and sets recoveredFromExit', async () => {
    const cap = createCapturingBus();
    const sess = session();
    await fs.mkdir(dirname(String(sess.signalsFile)), { recursive: true });
    await fs.writeFile(String(sess.signalsFile), '{"signals":[]}', 'utf8');
    const { spawn } = makeSpawn([{ exitCode: 143 }]);
    const provider = createGrokProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.recoveredFromExit).toEqual({ code: 143, signal: null });
    const warn = cap.logs.find((l) => l.level === 'warn' && l.message.includes('signals.json captured'));
    expect(warn).toBeDefined();
  });

  it('rate-limit on attempt 1, success on attempt 2 → resumes via -r <id>', async () => {
    const cap = createCapturingBus();
    const { spawn, calls } = makeSpawn([
      {
        stdoutChunks: [`${END_LINE}\n`],
        stderrChunks: ['Error: rate limit exceeded\n'],
        exitCode: 1,
      },
      { stdoutChunks: [`${END_LINE}\n`], exitCode: 0 },
    ]);
    const provider = createGrokProvider({
      rateLimitRetries: 2,
      eventBus: cap.bus,
      spawn,
      backoffSchedule: [0, 0, 0],
    });
    const out = await provider.generate(session());
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).not.toContain('-r');
    const idx = calls[1]!.args.indexOf('-r');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(calls[1]!.args[idx + 1]).toBe('01a047e3-cfea-7b83-8047-31c8c2a39cc8');
  });

  it('surfaces the stdout error record in the failure message when stderr is empty', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeSpawn([
      {
        stdoutChunks: ['{"type":"error","message":"Session not found locally"}\n'],
        exitCode: 1,
      },
    ]);
    const provider = createGrokProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(session());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toContain('Session not found locally');
    expect(out.error.message).not.toContain('<empty stderr>');
    expect(cap.logs.some((l) => l.level === 'warn' && l.message.includes('Session not found locally'))).toBe(true);
  });

  it('falls back to a cold spawn when the resume id is stale', async () => {
    const cap = createCapturingBus();
    const { spawn, calls } = makeSpawn([
      {
        stdoutChunks: ['{"type":"error","message":"Session \\"gone-id\\" not found locally"}\n'],
        exitCode: 1,
      },
      { stdoutChunks: [`${END_LINE}\n`], exitCode: 0 },
    ]);
    const provider = createGrokProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(session({ resume: 'gone-id' as unknown as SessionId }));
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const firstResume = calls[0]!.args.indexOf('-r');
    expect(firstResume).toBeGreaterThanOrEqual(0);
    expect(calls[0]!.args[firstResume + 1]).toBe('gone-id');
    expect(calls[1]!.args).not.toContain('-r');
    expect(cap.logs.some((l) => l.level === 'warn' && /resume thread not found/i.test(l.message))).toBe(true);
  });

  it('falls back to a cold spawn when restore fails with session get failed: 404', async () => {
    const cap = createCapturingBus();
    const { spawn, calls } = makeSpawn([
      {
        stdoutChunks: [
          '{"type":"error","message":"Failed to restore session from remote: fetching session record: session get failed: 404"}\n',
        ],
        exitCode: 1,
      },
      { stdoutChunks: [`${END_LINE}\n`], exitCode: 0 },
    ]);
    const provider = createGrokProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(session({ resume: 'gone-id' as unknown as SessionId }));
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toContain('-r');
    expect(calls[1]!.args).not.toContain('-r');
  });

  it('does not cold-retry a session-not-found crash when resume is unset', async () => {
    const cap = createCapturingBus();
    const { spawn, calls } = makeSpawn([
      {
        stdoutChunks: ['{"type":"error","message":"Session not found locally"}\n'],
        exitCode: 1,
      },
    ]);
    const provider = createGrokProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(session());
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(cap.logs.some((l) => l.level === 'warn' && /resume thread not found/i.test(l.message))).toBe(false);
  });
});
