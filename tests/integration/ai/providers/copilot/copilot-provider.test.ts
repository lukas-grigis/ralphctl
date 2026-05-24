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
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';
import { buildCopilotArgs, createCopilotProvider } from '@src/integration/ai/providers/copilot/headless.ts';
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

const unwrapArgs = (s: AiSession): readonly string[] => {
  const r = buildCopilotArgs(s);
  if (!r.ok) throw new Error(`buildCopilotArgs failed: ${r.error.message}`);
  return r.value;
};

describe('createCopilotProvider', () => {
  it('happy path: captures sessionId from streamed events WITHOUT writing signals.json (AI Write tool owns it)', async () => {
    const cap = createCapturingBus();
    const sess = session();

    const { spawn } = makeSpawn([
      {
        stdoutChunks: [
          '{"session_id":"sess-1","model":"gpt-5.1"}\n',
          '{"type":"assistant.message_delta","data":{"deltaContent":"completed task"}}\n',
          '{"type":"assistant.message_delta","data":{"deltaContent":"; wrote signals.json."}}\n',
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
    // Provider must NOT touch signals.json — that's the AI's job under audit-[09].
    await expect(fs.access(String(out.value.signalsFile))).rejects.toMatchObject({ code: 'ENOENT' });
    const sessionEntry = cap.logs.find((e) => e.message.includes('session id'));
    expect(sessionEntry?.meta?.['sessionId']).toBe('sess-1');
  });

  it('persists session-id.txt as a sibling file when captured (UTF-8, one line + trailing newline)', async () => {
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

    const sidPath = join(dirname(String(sess.signalsFile)), 'session-id.txt');
    const sidContent = await fs.readFile(sidPath, 'utf8');
    expect(sidContent).toBe('sess-persist\n');
    expect(out.value.sessionId).toBe('sess-persist');
  });

  it('skips the session-id.txt file when no meta line carried a session_id (no empty marker)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    // Only plain-text body lines — no JSON meta line, so no session_id is ever extracted.
    const { spawn } = makeSpawn([{ stdoutChunks: ['<task-complete/>\n'], exitCode: 0 }]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
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

    const sidPath = join(dirname(String(sess.signalsFile)), 'session-id.txt');
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

  it('consumes JSON-only assistant delta events without writing signals.json', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeSpawn([
      {
        stdoutChunks: [
          '{"session_id":"sess-json","model":"gpt-5.1"}\n',
          '{"type":"assistant.message_delta","data":{"deltaContent":"working"}}\n',
          '{"type":"assistant.message_delta","data":{"deltaContent":"; verified."}}\n',
        ],
        exitCode: 0,
      },
    ]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.sessionId).toBe('sess-json');
    // Provider never writes signals.json post-audit-[09].
    await expect(fs.access(String(out.value.signalsFile))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('mirrors accumulated body to session.bodyFile when set (detect-scripts forensic surface)', async () => {
    const cap = createCapturingBus();
    const signalsFile = tempSignalsFile();
    const bodyFile = absolutePath(join(dirname(String(signalsFile)), 'body.txt'));
    const sess = session({ signalsFile, bodyFile });
    const { spawn } = makeSpawn([
      {
        stdoutChunks: [
          '{"session_id":"sess-body","model":"gpt-5.1"}\n',
          'plain text body line\n',
          '<task-complete/>\n',
        ],
        exitCode: 0,
      },
    ]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    const contents = await fs.readFile(String(bodyFile), 'utf8');
    expect(contents).toContain('plain text body line');
    expect(contents).toContain('<task-complete/>');
  });

  it('writes body even when no signals.json appeared (empty proposal forensic capture)', async () => {
    const cap = createCapturingBus();
    const signalsFile = tempSignalsFile();
    const bodyFile = absolutePath(join(dirname(String(signalsFile)), 'body.txt'));
    const sess = session({ signalsFile, bodyFile });
    // The AI did not emit anything that would lead it to write `signals.json`. The forensic
    // body.txt is exactly the surface operators need to debug an empty proposal.
    const { spawn } = makeSpawn([
      {
        stdoutChunks: [
          '{"session_id":"sess-empty","model":"gpt-5.1"}\n',
          'I considered the repo but did not find conclusive scripts.\n',
        ],
        exitCode: 0,
      },
    ]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    // Provider never writes signals.json — only the AI does (via its Write tool).
    await expect(fs.access(String(signalsFile))).rejects.toMatchObject({ code: 'ENOENT' });
    const contents = await fs.readFile(String(bodyFile), 'utf8');
    expect(contents).toContain('did not find conclusive scripts');
  });

  it('forwards session.cwd to the spawned child (context-file autoload)', async () => {
    const cap = createCapturingBus();
    const cwd = absolutePath('/tmp/some-target-repo');
    const sess = session({ cwd });
    const { spawn, calls } = makeSpawn([
      { stdoutChunks: ['{"session_id":"sess-cwd","model":"gpt-5.1"}\n', '<task-complete/>\n'], exitCode: 0 },
    ]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe('/tmp/some-target-repo');
  });

  it('preserves unrecognised JSON event raw form in body.txt (forensic fall-through)', async () => {
    const cap = createCapturingBus();
    const signalsFile = tempSignalsFile();
    const bodyFile = absolutePath(join(dirname(String(signalsFile)), 'body.txt'));
    const sess = session({ signalsFile, bodyFile });
    // Mix of: a session-id meta line (should NOT appear in body), an unrecognised event
    // shape (SHOULD appear raw — this is the forensic capture path), and a recognised
    // assistant delta (SHOULD appear as its extracted bodyText).
    const unknownEvt = '{"type":"tool_call.delta","data":{"name":"Read","args":{"path":"/x"}}}';
    const knownDelta = '{"type":"assistant.message_delta","data":{"deltaContent":"<task-complete/>"}}';
    const { spawn } = makeSpawn([
      {
        stdoutChunks: [`{"session_id":"sess-mix","model":"gpt-5.1"}\n${unknownEvt}\n${knownDelta}\n`],
        exitCode: 0,
      },
    ]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    const contents = await fs.readFile(String(bodyFile), 'utf8');
    expect(contents).toContain(unknownEvt);
    expect(contents).toContain('<task-complete/>');
    // The pure meta line (sessionId + model only) is NOT body — keep it out so it can't
    // bias signal parsing or confuse a human reading body.txt.
    expect(contents).not.toContain('"session_id":"sess-mix"');
  });

  it('captures the user.message prompt-echo line in body.txt without writing signals.json', async () => {
    // Pre-audit-[09] regression record: Copilot mirrors the user prompt back as a `user.message`
    // event whose `data.content` echoes prompt text verbatim. Before the audit, that line could
    // leak into the legacy signal parser and produce a fake signal. Post-audit the provider
    // never parses signals at all — but the forensic body.txt still keeps the line so operators
    // can audit what Copilot streamed.
    const cap = createCapturingBus();
    const signalsFile = tempSignalsFile();
    const bodyFile = absolutePath(join(dirname(String(signalsFile)), 'body.txt'));
    const sess = session({ signalsFile, bodyFile });
    const userEcho = JSON.stringify({
      type: 'user.message',
      data: { content: 'Tools available — emit a task-blocked signal when stuck.' },
    });
    const assistantTurn = JSON.stringify({
      type: 'assistant.message',
      data: { content: 'I will proceed with the change.' },
    });
    const { spawn } = makeSpawn([
      {
        stdoutChunks: [`{"session_id":"sess-echo","model":"gpt-5.1"}\n${userEcho}\n${assistantTurn}\n`],
        exitCode: 0,
      },
    ]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    // Provider never writes signals.json — only the AI does.
    await expect(fs.access(String(signalsFile))).rejects.toMatchObject({ code: 'ENOENT' });
    // Forensic capture still includes the user.message line so operators see what Copilot
    // actually streamed.
    const contents = await fs.readFile(String(bodyFile), 'utf8');
    expect(contents).toContain(userEcho);
  });

  it('overwrites an already-existing bodyFile target (atomic write does not crash)', async () => {
    const cap = createCapturingBus();
    const signalsFile = tempSignalsFile();
    const bodyFile = absolutePath(join(dirname(String(signalsFile)), 'body.txt'));
    // Pre-create the target so the rename-based atomic write must clobber, not refuse.
    await fs.mkdir(dirname(String(bodyFile)), { recursive: true });
    await fs.writeFile(String(bodyFile), 'stale prior content\n', 'utf8');
    const sess = session({ signalsFile, bodyFile });
    const { spawn } = makeSpawn([
      {
        stdoutChunks: ['{"session_id":"sess-clobber","model":"gpt-5.1"}\n', 'fresh body\n'],
        exitCode: 0,
      },
    ]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    const contents = await fs.readFile(String(bodyFile), 'utf8');
    expect(contents).toContain('fresh body');
    expect(contents).not.toContain('stale prior content');
  });
});

describe('createCopilotProvider — TokenUsageEvent emission', () => {
  it('emits one TokenUsageEvent on clean exit even when the meta line lacks usage counters', async () => {
    const cap = createCapturingBus();
    const sess = session();
    // Bare meta line — sessionId + model, no usage object. Honest about missing fields.
    const { spawn } = makeSpawn([
      {
        stdoutChunks: ['{"session_id":"sess-tu","model":"gpt-5.1"}\n', '<task-complete/>\n'],
        exitCode: 0,
      },
    ]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    const tokenEvents = cap.events.filter((e): e is TokenUsageEvent => e.type === 'token-usage');
    expect(tokenEvents).toHaveLength(1);
    const evt = tokenEvents[0]!;
    expect(evt.provider).toBe('github-copilot');
    expect(evt.sessionId).toBe('sess-tu');
    expect(evt.model).toBe('gpt-5.1');
    expect(evt.inputTokens).toBeUndefined();
    expect(evt.outputTokens).toBeUndefined();
    // Copilot models are not in the static context-window table.
    expect(evt.contextWindow).toBeUndefined();
  });

  it('includes usage counters when the meta line surfaces a usage object', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const meta = JSON.stringify({
      session_id: 'sess-u',
      model: 'gpt-5.1',
      usage: { input_tokens: 444, output_tokens: 222 },
    });
    const { spawn } = makeSpawn([{ stdoutChunks: [`${meta}\n`, '<task-complete/>\n'], exitCode: 0 }]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    const tokenEvents = cap.events.filter((e): e is TokenUsageEvent => e.type === 'token-usage');
    expect(tokenEvents).toHaveLength(1);
    const evt = tokenEvents[0]!;
    expect(evt.sessionId).toBe('sess-u');
    expect(evt.inputTokens).toBe(444);
    expect(evt.outputTokens).toBe(222);
  });

  it('does NOT emit a TokenUsageEvent on spawn failure (non-zero exit)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeSpawn([
      {
        stdoutChunks: ['{"session_id":"sess-fail","model":"gpt-5.1"}\n'],
        stderrChunks: ['boom\n'],
        exitCode: 7,
      },
    ]);
    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(false);

    expect(cap.events.filter((e) => e.type === 'token-usage')).toHaveLength(0);
  });
});

describe('buildCopilotArgs — AiSession → CLI flag translation', () => {
  it.each(COPILOT_MODELS.map((m) => [m]))('passes through --model=%s', (model) => {
    const args = unwrapArgs(session({ model }));
    expect(args).toContain(`--model=${model}`);
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

  it('maps read-only permissions to --allow-all-tools --deny-tool=shell (write stays open for signals.json)', () => {
    const args = unwrapArgs(session({ permissions: READ_ONLY }));
    // Allow everything by default, then deny shell. Write tool stays open because the
    // audit-[09] contract needs it to land signals.json in outputDir. Copilot has no
    // fine-grained edit-vs-write split (the `write` kind covers all file mutations), so
    // path scope (cwd + --add-dir) carries the responsibility of keeping the AI inside.
    expect(args).toContain('--allow-all-tools');
    expect(args).not.toContain('--deny-tool=write');
    expect(args).toContain('--deny-tool=shell');
    // Belt-and-braces: the old `shell(*)` form is invalid per the CLI docs.
    expect(args).not.toContain('--deny-tool=shell(*)');
    expect(args).not.toContain('--allow-all');
  });

  it('emits one --add-dir=<path> per additionalRoots entry, in declared order', () => {
    const a = absolutePath('/tmp/repo-a');
    const b = absolutePath('/tmp/repo-b');
    const args = unwrapArgs(session({ additionalRoots: [a, b] }));
    const addDirEntries = args.filter((s) => s.startsWith('--add-dir'));
    expect(addDirEntries).toEqual(['--add-dir=/tmp/repo-a', '--add-dir=/tmp/repo-b']);
    expect(args).not.toContain('--add-dir');
  });

  it('omits --add-dir when additionalRoots is undefined or empty', () => {
    expect(unwrapArgs(session()).some((s) => s.startsWith('--add-dir'))).toBe(false);
    expect(unwrapArgs(session({ additionalRoots: [] })).some((s) => s.startsWith('--add-dir'))).toBe(false);
  });

  it('passes through session.resume as --resume=<id>', () => {
    const id = 'sess-abc' as unknown as SessionId;
    const args = unwrapArgs(session({ resume: id }));
    expect(args).toContain('--resume=sess-abc');
  });

  it('emits --effort=<level> when session.effort is set (forwarded verbatim)', () => {
    const args = unwrapArgs(session({ effort: 'xhigh' }));
    expect(args).toContain('--effort=xhigh');
  });

  it('omits --effort when session.effort is undefined', () => {
    expect(unwrapArgs(session()).some((s) => s.startsWith('--effort'))).toBe(false);
  });

  it('emits the prompt as the trailing -p argv pair', () => {
    const args = unwrapArgs(session());
    const idx = args.indexOf('-p');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(PROMPT as unknown as string);
  });
});
