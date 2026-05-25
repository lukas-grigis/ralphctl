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
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { buildClaudeArgs, createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import type { TokenUsageEvent } from '@src/business/observability/events.ts';

interface FakeChildScript {
  readonly stdoutChunks?: readonly string[];
  readonly stderrChunks?: readonly string[];
  readonly exitCode?: number | null;
  readonly exitSignal?: NodeJS.Signals | null;
  readonly exitDelayMs?: number;
  readonly hang?: boolean;
}

const makeStream = (): EventEmitter & { setEncoding: (e: string) => void } => {
  const ee = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  ee.setEncoding = (): void => {
    // no-op for tests
  };
  return ee;
};

const makeFakeChild = (script: FakeChildScript): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { _killed: boolean };
  const stdout = makeStream();
  const stderr = makeStream();
  const stdin = {
    end(_data: unknown): void {
      void _data;
    },
  };
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    child.emit('exit', code, signal);
    setTimeout(() => child.emit('close', code, signal), 0);
  };
  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    kill(): boolean {
      child._killed = true;
      setTimeout(() => finish(null, 'SIGTERM'), 0);
      return true;
    },
    _killed: false,
  });

  setTimeout(() => {
    for (const chunk of script.stdoutChunks ?? []) stdout.emit('data', chunk);
    for (const chunk of script.stderrChunks ?? []) stderr.emit('data', chunk);
    if (script.hang === true) return;
    setTimeout(() => finish(script.exitCode ?? 0, script.exitSignal ?? null), script.exitDelayMs ?? 0);
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
const CWD = absolutePath('/tmp/claude-provider-test');

let tempCounter = 0;
const tempSignalsFile = () => {
  tempCounter += 1;
  // Per-test sub-directory so the sibling `sessionId` file written next to `signals.json`
  // does not collide with another test's expected-missing assertion in the same parent.
  return absolutePath(
    join(
      tmpdir(),
      `ralphctl-claude-test-${String(process.pid)}-${String(Date.now())}-${String(tempCounter)}`,
      'signals.json'
    )
  );
};

const session = (overrides: Partial<AiSession> = {}): AiSession => ({
  prompt: PROMPT,
  cwd: CWD,
  model: 'claude-sonnet-4-6',
  permissions: READ_ONLY,
  signalsFile: tempSignalsFile(),
  ...overrides,
});

const unwrapArgs = (s: AiSession): readonly string[] => {
  const r = buildClaudeArgs(s);
  if (!r.ok) throw new Error(`buildClaudeArgs failed: ${r.error.message}`);
  return r.value;
};

describe('createClaudeProvider', () => {
  it('happy path: captures sessionId and returns ProviderOutput WITHOUT writing signals.json (AI Write tool owns it)', async () => {
    const cap = createCapturingBus();
    const sess = session();

    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'sonnet' });
    const resultEvt = JSON.stringify({
      type: 'result',
      subtype: 'success',
      // The AI's natural-language body is no longer scraped for signals — audit-[09] makes the AI
      // write `signals.json` directly via its Write tool. The body stays as-is for forensic capture.
      result: 'completed task; wrote signals.json.',
      session_id: 'sess-1',
      num_turns: 4,
    });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${init}\n${resultEvt}\n`], exitCode: 0 }]);

    const provider = createClaudeProvider({
      rateLimitRetries: 2,
      eventBus: cap.bus,
      spawn,
    });

    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.sessionId).toBe('sess-1');
    expect(out.value.exitCode).toBe(0);
    // Provider must NOT touch signals.json — that's the AI's job under the audit-[09] contract.
    await expect(fs.access(String(out.value.signalsFile))).rejects.toMatchObject({ code: 'ENOENT' });
    const sessionEntry = cap.logs.find((e) => e.message.includes('session id'));
    expect(sessionEntry?.meta?.['sessionId']).toBe('sess-1');
  });

  it('forwards session.cwd to the spawned child (context-file autoload)', async () => {
    const cap = createCapturingBus();
    const cwd = absolutePath('/tmp/claude-target-repo');
    const sess = session({ cwd });
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-cwd', model: 'sonnet' });
    const resultEvt = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 'sess-cwd' });
    const { spawn, calls } = makeSpawn([{ stdoutChunks: [`${init}\n${resultEvt}\n`], exitCode: 0 }]);

    const provider = createClaudeProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe('/tmp/claude-target-repo');
  });

  it('rate-limit: retries up to N times and surfaces RateLimitError when exhausted', async () => {
    const cap = createCapturingBus();
    const rateLimitScript: FakeChildScript = {
      stderrChunks: ['Error: rate limit exceeded; please retry later\n'],
      exitCode: 1,
    };
    const { spawn } = makeSpawn([rateLimitScript, rateLimitScript, rateLimitScript]);

    const provider = createClaudeProvider({
      rateLimitRetries: 2,
      eventBus: cap.bus,
      spawn,
      backoffSchedule: [0, 0, 0], // skip the 1m → 5m → 30m waits in tests
    });

    const out = await provider.generate(session());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('rate-limit');

    const warns = cap.logs.filter((e) => e.level === 'warn');
    expect(warns.length).toBeGreaterThanOrEqual(2);
  });

  it('rate-limit then success: returns ok after a retry succeeds', async () => {
    const cap = createCapturingBus();
    const sess = session();

    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-2', model: 'sonnet' });
    const okResult = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '<task-complete/>',
      session_id: 'sess-2',
    });
    const { spawn } = makeSpawn([
      { stderrChunks: ['rate-limit hit\n'], exitCode: 1 },
      { stdoutChunks: [`${init}\n${okResult}\n`], exitCode: 0 },
    ]);

    const provider = createClaudeProvider({
      rateLimitRetries: 2,
      eventBus: cap.bus,
      spawn,
      backoffSchedule: [0, 0, 0],
    });

    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.sessionId).toBe('sess-2');
    expect(out.value.exitCode).toBe(0);
    // Provider does not write signals.json post-audit-[09]; the AI's Write tool does.
    await expect(fs.access(String(out.value.signalsFile))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists session-id.txt as a sibling file when captured (UTF-8, one line + trailing newline)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-persist', model: 'sonnet' });
    const resultEvt = JSON.stringify({ type: 'result', result: '<task-complete/>', session_id: 'sess-persist' });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${init}\n${resultEvt}\n`], exitCode: 0 }]);

    const provider = createClaudeProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const sidPath = join(dirname(String(sess.signalsFile)), 'session-id.txt');
    const sidContent = await fs.readFile(sidPath, 'utf8');
    expect(sidContent).toBe('sess-persist\n');
    expect(out.value.sessionId).toBe('sess-persist');
  });

  it('skips the session-id.txt file when the stream never emitted a session_id (no empty marker)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    // result event WITHOUT session_id — Claude can omit it on early-exit / malformed init.
    const resultEvt = JSON.stringify({ type: 'result', result: '<task-complete/>' });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${resultEvt}\n`], exitCode: 0 }]);

    const provider = createClaudeProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.sessionId).toBeUndefined();

    const sidPath = join(dirname(String(sess.signalsFile)), 'session-id.txt');
    await expect(fs.access(sidPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not write session-id.txt on non-zero exit (spawn failure path)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-doomed', model: 'sonnet' });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${init}\n`], stderrChunks: ['boom\n'], exitCode: 2 }]);

    const provider = createClaudeProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(false);

    const sidPath = join(dirname(String(sess.signalsFile)), 'session-id.txt');
    await expect(fs.access(sidPath)).rejects.toMatchObject({ code: 'ENOENT' });
    // signals.json is also never written on the failure path.
    await expect(fs.access(String(sess.signalsFile))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('non-rate-limit failure: surfaces InvalidStateError without retrying', async () => {
    const cap = createCapturingBus();
    const calls = { n: 0 };
    const spawn: ProviderSpawn = () => {
      calls.n++;
      return makeFakeChild({ stderrChunks: ['fatal: model not found\n'], exitCode: 2 });
    };

    const provider = createClaudeProvider({
      rateLimitRetries: 3,
      eventBus: cap.bus,
      spawn,
    });

    const out = await provider.generate(session());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('invalid-state');
    expect(calls.n).toBe(1);
  });
});

describe('createClaudeProvider — TokenUsageEvent emission', () => {
  it('emits one TokenUsageEvent on clean exit with usage from the result event', async () => {
    const cap = createCapturingBus();
    const sess = session();

    const init = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-tu',
      model: 'claude-opus-4-7',
    });
    const resultEvt = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '<task-complete/>',
      session_id: 'sess-tu',
      usage: {
        input_tokens: 1234,
        output_tokens: 567,
        cache_read_input_tokens: 89,
        cache_creation_input_tokens: 12,
      },
    });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${init}\n${resultEvt}\n`], exitCode: 0 }]);

    const provider = createClaudeProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    const tokenEvents = cap.events.filter((e): e is TokenUsageEvent => e.type === 'token-usage');
    expect(tokenEvents).toHaveLength(1);
    const evt = tokenEvents[0]!;
    expect(evt.provider).toBe('claude-code');
    expect(evt.sessionId).toBe('sess-tu');
    expect(evt.model).toBe('claude-opus-4-7');
    expect(evt.inputTokens).toBe(1234);
    expect(evt.outputTokens).toBe(567);
    expect(evt.cacheReadTokens).toBe(89);
    expect(evt.cacheCreationTokens).toBe(12);
    // claude-opus-4-7 is in the static context-window table at 200k.
    expect(evt.contextWindow).toBe(200_000);
  });

  it('omits contextWindow when the model is unknown to the lookup table', async () => {
    const cap = createCapturingBus();
    const sess = session();

    // Init carries an unknown model id; result event still surfaces usage.
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-mu', model: 'claude-future-9-9' });
    const resultEvt = JSON.stringify({
      type: 'result',
      result: '<task-complete/>',
      session_id: 'sess-mu',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${init}\n${resultEvt}\n`], exitCode: 0 }]);

    const provider = createClaudeProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    const tokenEvents = cap.events.filter((e): e is TokenUsageEvent => e.type === 'token-usage');
    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0]!.model).toBe('claude-future-9-9');
    expect(tokenEvents[0]!.contextWindow).toBeUndefined();
    expect(tokenEvents[0]!.inputTokens).toBe(100);
  });

  it('does NOT emit a TokenUsageEvent on spawn failure (non-zero exit)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-fail', model: 'claude-opus-4-7' });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${init}\n`], stderrChunks: ['boom\n'], exitCode: 2 }]);

    const provider = createClaudeProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(false);

    const tokenEvents = cap.events.filter((e) => e.type === 'token-usage');
    expect(tokenEvents).toHaveLength(0);
  });

  it('stamps the gen-eval role onto the event when the session carries one', async () => {
    const cap = createCapturingBus();
    const sess = session({ role: 'generator' });
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-role', model: 'claude-opus-4-7' });
    const resultEvt = JSON.stringify({
      type: 'result',
      result: '<task-complete/>',
      session_id: 'sess-role',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${init}\n${resultEvt}\n`], exitCode: 0 }]);

    const provider = createClaudeProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    const tokenEvents = cap.events.filter((e): e is TokenUsageEvent => e.type === 'token-usage');
    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0]!.role).toBe('generator');
  });

  it('omits role from the event when the session has no role (single-role flows)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const init = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-norole',
      model: 'claude-opus-4-7',
    });
    const resultEvt = JSON.stringify({ type: 'result', result: '<task-complete/>', session_id: 'sess-norole' });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${init}\n${resultEvt}\n`], exitCode: 0 }]);

    const provider = createClaudeProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    await provider.generate(sess);

    const tokenEvents = cap.events.filter((e): e is TokenUsageEvent => e.type === 'token-usage');
    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0]!.role).toBeUndefined();
  });

  it('emits the event without token counts when the result event lacks a usage object', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const init = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-nou',
      model: 'claude-sonnet-4-6',
    });
    const resultEvt = JSON.stringify({ type: 'result', result: '<task-complete/>', session_id: 'sess-nou' });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${init}\n${resultEvt}\n`], exitCode: 0 }]);

    const provider = createClaudeProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    const tokenEvents = cap.events.filter((e): e is TokenUsageEvent => e.type === 'token-usage');
    expect(tokenEvents).toHaveLength(1);
    const evt = tokenEvents[0]!;
    expect(evt.sessionId).toBe('sess-nou');
    expect(evt.model).toBe('claude-sonnet-4-6');
    expect(evt.contextWindow).toBe(200_000);
    expect(evt.inputTokens).toBeUndefined();
    expect(evt.outputTokens).toBeUndefined();
    expect(evt.cacheReadTokens).toBeUndefined();
    expect(evt.cacheCreationTokens).toBeUndefined();
  });
});

describe('buildClaudeArgs — AiSession → CLI flag translation', () => {
  it.each(CLAUDE_MODELS.map((m) => [m]))('passes through --model %s', (model) => {
    const args = unwrapArgs(session({ model }));
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(model);
  });

  it('rejects an unknown model with InvalidStateError', () => {
    const r = buildClaudeArgs(session({ model: 'gpt-5.4' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'gpt-5.4'");
  });

  it('always includes -p so claude runs in print/headless mode', () => {
    expect(unwrapArgs(session()).includes('-p')).toBe(true);
    expect(unwrapArgs(session({ permissions: FULL_AUTO })).includes('-p')).toBe(true);
    expect(unwrapArgs(session({ permissions: READ_ONLY })).includes('-p')).toBe(true);
  });

  it('emits --verbose + --output-format stream-json so stdout streams JSONL for the idle watchdog', () => {
    const args = unwrapArgs(session());
    expect(args).toContain('--verbose');
    const fmtIdx = args.indexOf('--output-format');
    expect(fmtIdx).toBeGreaterThanOrEqual(0);
    expect(args[fmtIdx + 1]).toBe('stream-json');
  });

  it('always emits --permission-mode bypassPermissions (deny rules carry the safety contract)', () => {
    const fullAutoArgs = unwrapArgs(session({ permissions: FULL_AUTO }));
    const readOnlyArgs = unwrapArgs(session({ permissions: READ_ONLY }));
    expect(fullAutoArgs[fullAutoArgs.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(readOnlyArgs[readOnlyArgs.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  });

  it('omits --disallowedTools entirely for full-auto sessions (every gate is open)', () => {
    const args = unwrapArgs(session({ permissions: FULL_AUTO }));
    expect(args.includes('--disallowedTools')).toBe(false);
  });

  it('read-only permissions deny Edit / MultiEdit / NotebookEdit / Bash but keep Read / Write / Grep / Glob open', () => {
    const args = unwrapArgs(session({ permissions: READ_ONLY }));
    const idx = args.indexOf('--disallowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    const denied = (args[idx + 1] ?? '').split(',');
    expect(denied).toEqual(expect.arrayContaining(['Edit', 'MultiEdit', 'NotebookEdit', 'Bash']));
    // Write stays open under every profile — the audit-[09] contract needs it to land
    // signals.json in outputDir. Path scope (cwd + --add-dir) keeps it pointed there.
    expect(denied).not.toContain('Write');
    expect(denied).not.toContain('Read');
    expect(denied).not.toContain('Grep');
    expect(denied).not.toContain('Glob');
  });

  it('half-permission set (edit-only, no shell, network OK) denies only Bash', () => {
    const args = unwrapArgs(
      session({
        permissions: { canModifyRepoFiles: true, canRunShell: false, canAccessNetwork: true, autoApprove: false },
      })
    );
    const idx = args.indexOf('--disallowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect((args[idx + 1] ?? '').split(',')).toEqual(['Bash']);
  });

  it('canAccessNetwork=false adds WebFetch + WebSearch to the deny list', () => {
    const args = unwrapArgs(
      session({
        permissions: { canModifyRepoFiles: false, canRunShell: false, canAccessNetwork: false, autoApprove: false },
      })
    );
    const idx = args.indexOf('--disallowedTools');
    const denied = (args[idx + 1] ?? '').split(',');
    expect(denied).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
  });

  it('emits one --add-dir per additionalRoots entry, in declared order', () => {
    const a = absolutePath('/tmp/repo-a');
    const b = absolutePath('/tmp/repo-b');
    const args = unwrapArgs(session({ additionalRoots: [a, b] }));
    const pairs: Array<readonly [string, string | undefined]> = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--add-dir') pairs.push([args[i] as string, args[i + 1]]);
    }
    expect(pairs).toEqual([
      ['--add-dir', '/tmp/repo-a'],
      ['--add-dir', '/tmp/repo-b'],
    ]);
  });

  it('omits --add-dir when additionalRoots is undefined or empty', () => {
    expect(unwrapArgs(session()).includes('--add-dir')).toBe(false);
    expect(unwrapArgs(session({ additionalRoots: [] })).includes('--add-dir')).toBe(false);
  });

  it('emits --resume <id> when session.resume is set', () => {
    const id = 'sess-abc' as unknown as SessionId;
    const args = unwrapArgs(session({ resume: id }));
    const idx = args.indexOf('--resume');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('sess-abc');
  });

  it('omits --resume when session.resume is undefined', () => {
    expect(unwrapArgs(session()).includes('--resume')).toBe(false);
  });

  it('emits --effort <level> when session.effort is set (forwarded verbatim)', () => {
    const args = unwrapArgs(session({ effort: 'xhigh' }));
    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('xhigh');
  });

  it('omits --effort when session.effort is undefined', () => {
    expect(unwrapArgs(session()).includes('--effort')).toBe(false);
  });

  it('passes the translated argv through spawn end-to-end', async () => {
    const cap = createCapturingBus();
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-e2e', model: 'claude-opus-4-7' });
    const resultEvt = JSON.stringify({ type: 'result', result: 'ok', session_id: 'sess-e2e' });
    const captured = makeSpawn([{ stdoutChunks: [`${init}\n${resultEvt}\n`], exitCode: 0 }]);

    const provider = createClaudeProvider({
      rateLimitRetries: 0,
      eventBus: cap.bus,
      spawn: captured.spawn,
    });

    const root = absolutePath('/tmp/extra-root');
    const id = 'sess-xyz' as unknown as SessionId;
    await provider.generate(
      session({ model: 'claude-opus-4-7', permissions: FULL_AUTO, additionalRoots: [root], resume: id })
    );

    expect(captured.calls).toHaveLength(1);
    const args = captured.calls[0]?.args ?? [];
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-7');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/tmp/extra-root');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-xyz');
  });

  it('non-zero exit (code 143) with signals.json present recovers and sets recoveredFromExit', async () => {
    // Faithful repro of the captured incident: macOS Node surfaces an idle-watchdog SIGTERM
    // as (code=143, signal=null), not (code=null, signal='SIGTERM'). The AI had already
    // written signals.json via its Write tool before the child wedged.
    const cap = createCapturingBus();
    const sess = session();
    await fs.mkdir(dirname(String(sess.signalsFile)), { recursive: true });
    await fs.writeFile(String(sess.signalsFile), '{"signals":[]}', 'utf8');
    const { spawn } = makeSpawn([{ exitCode: 143 }]);

    const provider = createClaudeProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.recoveredFromExit).toEqual({ code: 143, signal: null });
    // The recovery branch emits a warn log mentioning the signals capture.
    const warn = cap.logs.find((l) => l.level === 'warn' && l.message.includes('signals.json captured'));
    expect(warn).toBeDefined();
  });
});
