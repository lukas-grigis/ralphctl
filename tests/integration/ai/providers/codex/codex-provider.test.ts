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
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { buildCodexArgs, createCodexProvider } from '@src/integration/ai/providers/codex/headless.ts';
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
const CWD = absolutePath('/tmp/codex-provider-test');

let signalsCounter = 0;
const tempSignalsFile = () => {
  signalsCounter += 1;
  return absolutePath(
    join(tmpdir(), `ralphctl-codex-test-${String(process.pid)}-${String(Date.now())}-${String(signalsCounter)}.json`)
  );
};

let bodyCounter = 0;
const tempBodyFile = () => {
  bodyCounter += 1;
  return absolutePath(
    join(tmpdir(), `ralphctl-codex-body-${String(process.pid)}-${String(Date.now())}-${String(bodyCounter)}.txt`)
  );
};

const session = (overrides: Partial<AiSession> = {}): AiSession => ({
  prompt: PROMPT,
  cwd: CWD,
  model: 'gpt-5.3-codex',
  permissions: READ_ONLY,
  signalsFile: tempSignalsFile(),
  ...overrides,
});

const readSignals = async (path: string): Promise<readonly HarnessSignal[]> => {
  const raw = await fs.readFile(path, 'utf8');
  return JSON.parse(raw) as readonly HarnessSignal[];
};

const FIXED_OUT = '/tmp/ralphctl-codex-fixed.txt';
const stubFs = (
  body: string
): {
  readonly readFile: (path: string) => Promise<string>;
  readonly unlink: (path: string) => Promise<void>;
  readonly mkTempPath: () => string;
  readonly unlinks: readonly string[];
} => {
  const unlinks: string[] = [];
  return {
    readFile: async () => body,
    unlink: async (path: string) => {
      unlinks.push(path);
    },
    mkTempPath: () => FIXED_OUT,
    unlinks,
  };
};

const unwrapArgs = (s: AiSession, outputFile = FIXED_OUT): readonly string[] => {
  const r = buildCodexArgs(s, { outputFile });
  if (!r.ok) throw new Error(`buildCodexArgs failed: ${r.error.message}`);
  return r.value;
};

describe('createCodexProvider', () => {
  it('happy path: reads response from output tempfile, parses signals, captures sessionId from stdout JSONL', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeSpawn([{ stdoutChunks: ['{"session_id":"sess-1","type":"config"}\n'], exitCode: 0 }]);
    const fsStub = stubFs('<progress>working</progress>\n<task-verified>all good</task-verified>');

    const provider = createCodexProvider({
      rateLimitRetries: 2,
      eventBus: cap.bus,
      spawn,
      readFile: fsStub.readFile,
      unlink: fsStub.unlink,
      mkTempPath: fsStub.mkTempPath,
    });

    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.sessionId).toBe('sess-1');
    expect(out.value.exitCode).toBe(0);
    const signals = await readSignals(String(out.value.signalsFile));
    expect(signals.map((s) => s.type)).toEqual(['progress', 'task-verified']);
    expect(fsStub.unlinks).toEqual([FIXED_OUT]);
  });

  it('mirrors raw body to session.bodyFile when requested (diagnostic capture)', async () => {
    const cap = createCapturingBus();
    const bodyFile = tempBodyFile();
    const sess = session({ bodyFile });
    const { spawn } = makeSpawn([{ stdoutChunks: ['{"session_id":"sess-1","type":"config"}\n'], exitCode: 0 }]);
    const fsStub = stubFs('<task-verified>all good</task-verified>');

    const provider = createCodexProvider({
      rateLimitRetries: 0,
      eventBus: cap.bus,
      spawn,
      readFile: fsStub.readFile,
      unlink: fsStub.unlink,
      mkTempPath: fsStub.mkTempPath,
    });

    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const mirrored = await fs.readFile(String(bodyFile), 'utf8');
    expect(mirrored).toBe('<task-verified>all good</task-verified>');
  });

  it('rate-limit: retries up to N times and surfaces RateLimitError when exhausted', async () => {
    const cap = createCapturingBus();
    const rate: FakeChildScript = { stderrChunks: ['Error: rate limit exceeded\n'], exitCode: 1 };
    const { spawn } = makeSpawn([rate, rate, rate]);
    const fsStub = stubFs('unused');

    const provider = createCodexProvider({
      rateLimitRetries: 2,
      eventBus: cap.bus,
      spawn,
      readFile: fsStub.readFile,
      unlink: fsStub.unlink,
      mkTempPath: fsStub.mkTempPath,
      backoffSchedule: [0, 0, 0],
    });

    const out = await provider.generate(session());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('rate-limit');
  });

  it('cleans up the output tempfile even when the call errors', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeSpawn([{ stderrChunks: ['some failure\n'], exitCode: 7 }]);
    const fsStub = stubFs('unused');

    const provider = createCodexProvider({
      rateLimitRetries: 0,
      eventBus: cap.bus,
      spawn,
      readFile: fsStub.readFile,
      unlink: fsStub.unlink,
      mkTempPath: fsStub.mkTempPath,
    });

    await provider.generate(session());
    expect(fsStub.unlinks).toEqual([FIXED_OUT]);
  });
});

describe('buildCodexArgs — AiSession → CLI argv translation', () => {
  it.each(CODEX_MODELS.map((m) => [m]))('passes through -m %s', (model) => {
    const args = unwrapArgs(session({ model }));
    const idx = args.indexOf('-m');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(model);
  });

  it('rejects an unknown model with InvalidStateError', () => {
    const r = buildCodexArgs(session({ model: 'gpt-4.1' }), { outputFile: FIXED_OUT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'gpt-4.1'");
  });

  it('starts argv with `exec` when resume is unset', () => {
    const args = unwrapArgs(session());
    expect(args[0]).toBe('exec');
    expect(args[1]).not.toBe('resume');
  });

  it('starts argv with `exec resume <id>` when resume is set', () => {
    const id = 'sess-abc' as unknown as SessionId;
    const args = unwrapArgs(session({ resume: id }));
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'sess-abc']);
  });

  it('always emits --ephemeral, --skip-git-repo-check, -o <tmpfile>, --json', () => {
    const args = unwrapArgs(session(), '/tmp/out-x.txt');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--json');
    const oIdx = args.indexOf('-o');
    expect(oIdx).toBeGreaterThanOrEqual(0);
    expect(args[oIdx + 1]).toBe('/tmp/out-x.txt');
  });

  it('maps READ_ONLY permissions to -s read-only (no -a; codex exec has no approval flag)', () => {
    const args = unwrapArgs(session({ permissions: READ_ONLY }));
    const sIdx = args.indexOf('-s');
    expect(args[sIdx + 1]).toBe('read-only');
    expect(args).not.toContain('-a');
  });

  it('maps FULL_AUTO permissions to -s workspace-write (no -a; codex exec has no approval flag)', () => {
    const args = unwrapArgs(session({ permissions: FULL_AUTO }));
    const sIdx = args.indexOf('-s');
    expect(args[sIdx + 1]).toBe('workspace-write');
    expect(args).not.toContain('-a');
  });

  it('omits -s for resume sessions because `codex exec resume` rejects it', () => {
    const id = 'sess-abc' as unknown as SessionId;
    const args = unwrapArgs(session({ resume: id, permissions: FULL_AUTO }));
    expect(args).not.toContain('-s');
  });

  it('rejects intermediate permission combinations with InvalidStateError', () => {
    const half = { canEditFiles: true, canRunShell: false, canAccessNetwork: true, autoApprove: false };
    const r = buildCodexArgs(session({ permissions: half }), { outputFile: FIXED_OUT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain('READ_ONLY and FULL_AUTO');
  });

  it('emits -C <cwd>', () => {
    const args = unwrapArgs(session());
    const idx = args.indexOf('-C');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(String(CWD));
  });

  it('omits -C for resume sessions because `codex exec resume` rejects it', () => {
    const id = 'sess-abc' as unknown as SessionId;
    const args = unwrapArgs(session({ resume: id }));
    expect(args).not.toContain('-C');
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

  it('omits --add-dir for resume sessions because `codex exec resume` rejects it', () => {
    const id = 'sess-abc' as unknown as SessionId;
    const a = absolutePath('/tmp/repo-a');
    const args = unwrapArgs(session({ resume: id, additionalRoots: [a] }));
    expect(args).not.toContain('--add-dir');
  });

  it('emits -c model_reasoning_effort=<level> when reasoningEffort is set', () => {
    const r = buildCodexArgs(session(), { outputFile: FIXED_OUT, reasoningEffort: 'high' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cIdx = r.value.indexOf('-c');
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(r.value[cIdx + 1]).toBe('model_reasoning_effort=high');
  });

  it('omits the reasoning override when reasoningEffort is unset', () => {
    expect(unwrapArgs(session()).includes('-c')).toBe(false);
  });

  it('ends argv with `-` so codex reads the prompt from stdin', () => {
    const args = unwrapArgs(session());
    expect(args.at(-1)).toBe('-');
  });

  it('keeps `-` as the trailing arg even with resume + reasoningEffort', () => {
    const id = 'sess-abc' as unknown as SessionId;
    const r = buildCodexArgs(session({ resume: id }), { outputFile: FIXED_OUT, reasoningEffort: 'high' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.at(-1)).toBe('-');
  });
});
