import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import { FULL_AUTO, READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';
import { buildCopilotArgs, createCopilotProvider } from '@src/integration/ai/providers/copilot/headless.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';

interface FakeChildScript {
  readonly stdoutChunks?: readonly string[];
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
      setTimeout(() => child.emit('exit', null, 'SIGTERM'), 0);
      return true;
    },
    _killed: false,
  });
  setTimeout(() => {
    for (const chunk of script.stdoutChunks ?? []) stdout.emit('data', chunk);
    for (const chunk of script.stderrChunks ?? []) stderr.emit('data', chunk);
    if (script.hang === true) return;
    setTimeout(() => child.emit('exit', script.exitCode ?? 0, script.exitSignal ?? null), 0);
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
const CWD = absolutePath('/tmp/copilot-provider-test');

let signalsCounter = 0;
const tempSignalsFile = () => {
  signalsCounter += 1;
  // Per-test sub-directory so the sibling `sessionId` file written next to `signals.json`
  // does not collide with another test's expected-missing assertion in the same parent.
  return absolutePath(
    join(
      tmpdir(),
      `ralphctl-copilot-test-${String(process.pid)}-${String(Date.now())}-${String(signalsCounter)}`,
      'signals.json'
    )
  );
};

const session = (overrides: Partial<AiSession> = {}): AiSession => ({
  prompt: PROMPT,
  cwd: CWD,
  model: 'gpt-5.1',
  permissions: READ_ONLY,
  signalsFile: tempSignalsFile(),
  ...overrides,
});

const readSignals = async (path: string): Promise<readonly HarnessSignal[]> => {
  const raw = await fs.readFile(path, 'utf8');
  return JSON.parse(raw) as readonly HarnessSignal[];
};

const unwrapArgs = (s: AiSession): readonly string[] => {
  const r = buildCopilotArgs(s);
  if (!r.ok) throw new Error(`buildCopilotArgs failed: ${r.error.message}`);
  return r.value;
};

describe('createCopilotProvider', () => {
  it('happy path: parses harness signals from streamed lines, captures sessionId, writes signalsFile', async () => {
    const cap = createCapturingBus();
    const sess = session();

    const { spawn } = makeSpawn([
      {
        stdoutChunks: [
          '{"session_id":"sess-1","model":"gpt-5.1"}\n',
          '<progress>working</progress>\n',
          '<task-verified>all good</task-verified>\n',
        ],
        exitCode: 0,
      },
    ]);

    const provider = createCopilotProvider({ rateLimitRetries: 2, eventBus: cap.bus, spawn });
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

  it('persists sessionId as a sibling file when captured (UTF-8, one line + trailing newline)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeSpawn([
      {
        stdoutChunks: ['{"session_id":"sess-persist","model":"gpt-5.1"}\n', '<task-complete/>\n'],
        exitCode: 0,
      },
    ]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const sidPath = join(dirname(String(sess.signalsFile)), 'sessionId');
    const sidContent = await fs.readFile(sidPath, 'utf8');
    expect(sidContent).toBe('sess-persist\n');
    expect(out.value.sessionId).toBe('sess-persist');
  });

  it('skips the sessionId file when no meta line carried a session_id (no empty marker)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    // Only plain-text body lines — no JSON meta line, so no session_id is ever extracted.
    const { spawn } = makeSpawn([{ stdoutChunks: ['<task-complete/>\n'], exitCode: 0 }]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.sessionId).toBeUndefined();

    const sidPath = join(dirname(String(sess.signalsFile)), 'sessionId');
    await expect(fs.access(sidPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not write sessionId on non-zero exit (spawn failure path)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeSpawn([
      {
        stdoutChunks: ['{"session_id":"sess-doomed"}\n'],
        stderrChunks: ['boom\n'],
        exitCode: 7,
      },
    ]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(false);

    const sidPath = join(dirname(String(sess.signalsFile)), 'sessionId');
    await expect(fs.access(sidPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(String(sess.signalsFile))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rate-limit: retries up to N times and surfaces RateLimitError when exhausted', async () => {
    const cap = createCapturingBus();
    const rate: FakeChildScript = { stderrChunks: ['Error: rate limit exceeded\n'], exitCode: 1 };
    const { spawn } = makeSpawn([rate, rate, rate]);
    const provider = createCopilotProvider({
      rateLimitRetries: 2,
      eventBus: cap.bus,
      spawn,
      backoffSchedule: [0, 0, 0],
    });
    const out = await provider.generate(session());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('rate-limit');
  });
});

describe('buildCopilotArgs — AiSession → CLI flag translation', () => {
  it.each(COPILOT_MODELS.map((m) => [m]))('passes through --model=%s (equals-only per CLI ref)', (model) => {
    const args = unwrapArgs(session({ model }));
    expect(args).toContain(`--model=${model}`);
    // Belt-and-braces: the space form silently corrupts argv parsing in v1.0.48+.
    expect(args).not.toContain('--model');
  });

  it('rejects an unknown model with InvalidStateError', () => {
    const r = buildCopilotArgs(session({ model: 'claude-haiku-4-5' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'claude-haiku-4-5'");
  });

  it('always emits --output-format=json --autopilot --silent --no-ask-user', () => {
    const args = unwrapArgs(session());
    expect(args).toContain('--output-format=json');
    expect(args).toContain('--autopilot');
    expect(args).toContain('--silent');
    expect(args).toContain('--no-ask-user');
  });

  it('maps full-auto permissions to --allow-all', () => {
    const args = unwrapArgs(session({ permissions: FULL_AUTO }));
    expect(args).toContain('--allow-all');
    expect(args).not.toContain('--deny-tool=write');
  });

  it('maps read-only permissions to --allow-all-tools --deny-tool=write --deny-tool=shell', () => {
    const args = unwrapArgs(session({ permissions: READ_ONLY }));
    // Allow everything by default, then deny the destructive tools. Deny rules take
    // precedence per the CLI docs. Without the explicit allow, --no-ask-user would turn
    // every read/search confirmation into a refusal.
    expect(args).toContain('--allow-all-tools');
    expect(args).toContain('--deny-tool=write');
    expect(args).toContain('--deny-tool=shell');
    // Belt-and-braces: the old `shell(*)` form is invalid per the CLI docs.
    expect(args).not.toContain('--deny-tool=shell(*)');
    expect(args).not.toContain('--allow-all');
  });

  it('emits one --add-dir=<path> per additionalRoots entry, in declared order (equals-only)', () => {
    const a = absolutePath('/tmp/repo-a');
    const b = absolutePath('/tmp/repo-b');
    const args = unwrapArgs(session({ additionalRoots: [a, b] }));
    const addDirEntries = args.filter((s) => s.startsWith('--add-dir'));
    expect(addDirEntries).toEqual(['--add-dir=/tmp/repo-a', '--add-dir=/tmp/repo-b']);
    // Belt-and-braces: the space form silently corrupts argv parsing in v1.0.48+.
    expect(args).not.toContain('--add-dir');
  });

  it('omits --add-dir when additionalRoots is undefined or empty', () => {
    expect(unwrapArgs(session()).some((s) => s.startsWith('--add-dir'))).toBe(false);
    expect(unwrapArgs(session({ additionalRoots: [] })).some((s) => s.startsWith('--add-dir'))).toBe(false);
  });

  it('rejects session.resume with InvalidStateError — --resume cannot combine with -p', () => {
    const id = 'sess-abc' as unknown as SessionId;
    const r = buildCopilotArgs(session({ resume: id }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain('--resume is interactive-only');
  });

  it('emits the prompt as the trailing -p argv pair', () => {
    const args = unwrapArgs(session());
    const idx = args.indexOf('-p');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(PROMPT as unknown as string);
  });
});
