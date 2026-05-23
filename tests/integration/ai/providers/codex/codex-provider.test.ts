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
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { buildCodexArgs, createCodexProvider } from '@src/integration/ai/providers/codex/headless.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import type { TokenUsageEvent } from '@src/business/observability/events.ts';

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
const CWD = absolutePath('/tmp/codex-provider-test');

let signalsCounter = 0;
const tempSignalsFile = () => {
  signalsCounter += 1;
  // Per-test sub-directory so the sibling `sessionId` file written next to `signals.json`
  // does not collide with another test's expected-missing assertion in the same parent.
  return absolutePath(
    join(
      tmpdir(),
      `ralphctl-codex-test-${String(process.pid)}-${String(Date.now())}-${String(signalsCounter)}`,
      'signals.json'
    )
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
  it('happy path: captures sessionId from stdout JSONL and unlinks codex tempfile WITHOUT writing signals.json', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeSpawn([{ stdoutChunks: ['{"session_id":"sess-1","type":"config"}\n'], exitCode: 0 }]);
    // The AI's natural-language body is no longer parsed for signals — audit-[09] makes the AI
    // write `signals.json` directly via its Write tool. The body remains for forensic capture.
    const fsStub = stubFs('completed task; wrote signals.json.');

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
    // Provider must NOT touch signals.json — that's the AI's job under audit-[09].
    await expect(fs.access(String(out.value.signalsFile))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fsStub.unlinks).toEqual([FIXED_OUT]);
  });

  it('forwards session.cwd to the spawned child (context-file autoload, parity with claude/copilot)', async () => {
    const cap = createCapturingBus();
    const cwd = absolutePath('/tmp/codex-target-repo');
    const sess = session({ cwd });
    const { spawn, calls } = makeSpawn([
      { stdoutChunks: ['{"session_id":"sess-cwd","type":"config"}\n'], exitCode: 0 },
    ]);
    const fsStub = stubFs('<task-complete/>');

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
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe('/tmp/codex-target-repo');
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

  it('persists sessionId as a sibling file when captured (UTF-8, one line + trailing newline)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeSpawn([{ stdoutChunks: ['{"session_id":"sess-persist","type":"config"}\n'], exitCode: 0 }]);
    const fsStub = stubFs('<task-complete/>');

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

    const sidPath = join(dirname(String(sess.signalsFile)), 'sessionId');
    const sidContent = await fs.readFile(sidPath, 'utf8');
    expect(sidContent).toBe('sess-persist\n');
    expect(out.value.sessionId).toBe('sess-persist');
  });

  it('skips the sessionId file when stdout never carried a session_id (no empty marker)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    // stdout JSONL with no session_id field — adapter must not write an empty sessionId file.
    const { spawn } = makeSpawn([{ stdoutChunks: ['{"type":"config"}\n'], exitCode: 0 }]);
    const fsStub = stubFs('<task-complete/>');

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
    expect(out.value.sessionId).toBeUndefined();

    const sidPath = join(dirname(String(sess.signalsFile)), 'sessionId');
    await expect(fs.access(sidPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not write sessionId on non-zero exit (spawn failure path)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeSpawn([
      {
        stdoutChunks: ['{"session_id":"sess-doomed","type":"config"}\n'],
        stderrChunks: ['boom\n'],
        exitCode: 7,
      },
    ]);
    const fsStub = stubFs('unused');

    const provider = createCodexProvider({
      rateLimitRetries: 0,
      eventBus: cap.bus,
      spawn,
      readFile: fsStub.readFile,
      unlink: fsStub.unlink,
      mkTempPath: fsStub.mkTempPath,
    });

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

describe('createCodexProvider — TokenUsageEvent emission', () => {
  it('emits one TokenUsageEvent on clean exit even when the JSONL stream lacks usage counters', async () => {
    const cap = createCapturingBus();
    const sess = session();
    // Bare config record — sessionId only; codex v0.130.x typically omits usage entirely.
    const { spawn } = makeSpawn([
      { stdoutChunks: ['{"session_id":"sess-tu","type":"config","model":"gpt-5.3-codex"}\n'], exitCode: 0 },
    ]);
    const fsStub = stubFs('<task-complete/>');

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

    const tokenEvents = cap.events.filter((e): e is TokenUsageEvent => e.type === 'token-usage');
    expect(tokenEvents).toHaveLength(1);
    const evt = tokenEvents[0]!;
    expect(evt.provider).toBe('openai-codex');
    expect(evt.sessionId).toBe('sess-tu');
    expect(evt.model).toBe('gpt-5.3-codex');
    expect(evt.inputTokens).toBeUndefined();
    expect(evt.outputTokens).toBeUndefined();
    // Codex models are not in the static context-window table.
    expect(evt.contextWindow).toBeUndefined();
  });

  it('includes usage counters when codex surfaces a usage object on a later record', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeSpawn([
      {
        stdoutChunks: [
          '{"session_id":"sess-u","type":"config","model":"gpt-5.3-codex"}\n',
          '{"type":"task_complete","usage":{"input_tokens":900,"output_tokens":300}}\n',
        ],
        exitCode: 0,
      },
    ]);
    const fsStub = stubFs('<task-complete/>');

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

    const tokenEvents = cap.events.filter((e): e is TokenUsageEvent => e.type === 'token-usage');
    expect(tokenEvents).toHaveLength(1);
    const evt = tokenEvents[0]!;
    expect(evt.sessionId).toBe('sess-u');
    expect(evt.inputTokens).toBe(900);
    expect(evt.outputTokens).toBe(300);
  });

  it('does NOT emit a TokenUsageEvent on spawn failure (non-zero exit)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeSpawn([
      {
        stdoutChunks: ['{"session_id":"sess-fail","type":"config","model":"gpt-5.3-codex"}\n'],
        stderrChunks: ['boom\n'],
        exitCode: 7,
      },
    ]);
    const fsStub = stubFs('unused');

    const provider = createCodexProvider({
      rateLimitRetries: 0,
      eventBus: cap.bus,
      spawn,
      readFile: fsStub.readFile,
      unlink: fsStub.unlink,
      mkTempPath: fsStub.mkTempPath,
    });

    const out = await provider.generate(sess);
    expect(out.ok).toBe(false);

    expect(cap.events.filter((e) => e.type === 'token-usage')).toHaveLength(0);
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

  it('maps READ_ONLY permissions to -s workspace-write (audit-[09] needs Write for signals.json)', () => {
    // Codex `exec` has only two sandbox modes: `read-only` blocks every write (including
    // signals.json), `workspace-write` allows writes inside cwd + --add-dir. Every profile
    // maps to workspace-write; path scope is the safety envelope.
    const args = unwrapArgs(session({ permissions: READ_ONLY }));
    const sIdx = args.indexOf('-s');
    expect(args[sIdx + 1]).toBe('workspace-write');
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

  it('accepts intermediate permission combinations (path scope is the envelope, not the profile)', () => {
    // The old contract rejected "intermediate" permission combinations because the codex
    // sandbox modes are binary. Under the contract pipeline, every spawn ends up at
    // workspace-write regardless — the SessionPermissions struct still carries semantic
    // intent for Claude / Copilot, but Codex only sees the topology.
    const half = { canModifyRepoFiles: true, canRunShell: false, canAccessNetwork: true, autoApprove: false };
    const r = buildCodexArgs(session({ permissions: half }), { outputFile: FIXED_OUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sIdx = r.value.indexOf('-s');
    expect(r.value[sIdx + 1]).toBe('workspace-write');
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
