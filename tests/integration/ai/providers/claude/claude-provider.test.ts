import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import { FULL_AUTO, READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { buildClaudeArgs, createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';

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
  readonly calls: ReadonlyArray<{ readonly command: string; readonly args: readonly string[] }>;
}

const makeSpawn = (scripts: readonly FakeChildScript[]): CapturingSpawnState => {
  let i = 0;
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawn: ProviderSpawn = (command, args) => {
    calls.push({ command, args });
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
  return absolutePath(
    join(tmpdir(), `ralphctl-claude-test-${String(process.pid)}-${String(Date.now())}-${String(tempCounter)}.json`)
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

const readSignals = async (path: string): Promise<readonly HarnessSignal[]> => {
  const raw = await fs.readFile(path, 'utf8');
  return JSON.parse(raw) as readonly HarnessSignal[];
};

const unwrapArgs = (s: AiSession): readonly string[] => {
  const r = buildClaudeArgs(s);
  if (!r.ok) throw new Error(`buildClaudeArgs failed: ${r.error.message}`);
  return r.value;
};

describe('createClaudeProvider', () => {
  it('happy path: parses harness signals from the JSON .result envelope and writes them to signalsFile', async () => {
    const cap = createCapturingBus();
    const sess = session();

    const envelope = JSON.stringify({
      session_id: 'sess-1',
      model: 'sonnet',
      result: '<progress>working</progress>\n<task-verified>all good</task-verified>',
      num_turns: 4,
    });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${envelope}\n`], exitCode: 0 }]);

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
    const signals = await readSignals(String(out.value.signalsFile));
    expect(signals.map((s) => s.type)).toEqual(['progress', 'task-verified']);
    const sessionEntry = cap.logs.find((e) => e.message.includes('session id'));
    expect(sessionEntry?.meta?.['sessionId']).toBe('sess-1');
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

    const okEnvelope = JSON.stringify({ session_id: 'sess-2', result: '<task-complete/>' });
    const { spawn } = makeSpawn([
      { stderrChunks: ['rate-limit hit\n'], exitCode: 1 },
      { stdoutChunks: [`${okEnvelope}\n`], exitCode: 0 },
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
    const signals = await readSignals(String(out.value.signalsFile));
    expect(signals.map((s) => s.type)).toEqual(['task-complete']);
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

  it('maps full autoApprove + edit + shell to --permission-mode bypassPermissions', () => {
    const args = unwrapArgs(session({ permissions: FULL_AUTO }));
    const idx = args.indexOf('--permission-mode');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('bypassPermissions');
  });

  it('maps read-only permissions to --permission-mode plan', () => {
    const args = unwrapArgs(session({ permissions: READ_ONLY }));
    const idx = args.indexOf('--permission-mode');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('plan');
  });

  it('maps a half-permission set to plan mode (closest available)', () => {
    const args = unwrapArgs(
      session({
        permissions: { canEditFiles: true, canRunShell: false, canAccessNetwork: true, autoApprove: false },
      })
    );
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('plan');
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

  it('passes the translated argv through spawn end-to-end', async () => {
    const cap = createCapturingBus();
    const captured = makeSpawn([{ stdoutChunks: ['{"result":"ok"}\n'], exitCode: 0 }]);

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
});
