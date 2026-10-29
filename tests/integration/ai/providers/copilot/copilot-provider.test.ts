import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import { FULL_AUTO, READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';
import { isSuspendedModel } from '@src/domain/value/settings-models/suspended-models.ts';
import { buildCopilotArgs, createCopilotProvider } from '@src/integration/ai/providers/copilot/headless.ts';
import type { TokenUsageEvent } from '@src/business/observability/events.ts';
import { makeProviderSpawn } from '@tests/fixtures/provider-spawn-fake.ts';
import type { SpawnScript } from '@src/integration/ai/providers/_engine/scripted-spawn.ts';

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
  model: 'gpt-5.6-sol',
  permissions: READ_ONLY,
  signalsFile: tempSignalsFile(),
  ...overrides,
});

// Inside cwd, so the prompt file's directory adds no `--add-dir` of its own to the argv under test.
const PROMPT_FILE_IN_CWD = join(String(CWD), 'copilot-prompt.md');

const unwrapArgs = (s: AiSession): readonly string[] => {
  const r = buildCopilotArgs(s, PROMPT_FILE_IN_CWD);
  if (!r.ok) throw new Error(`buildCopilotArgs failed: ${r.error.message}`);
  return r.value;
};

describe('createCopilotProvider', () => {
  it('happy path: captures sessionId from streamed events WITHOUT writing signals.json (AI Write tool owns it)', async () => {
    const cap = createCapturingBus();
    const sess = session();

    const { spawn } = makeProviderSpawn([
      {
        stdoutChunks: [
          '{"session_id":"sess-1","model":"gpt-5.6-sol"}\n',
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

  it('skips the session-id.txt file when no meta line carried a session_id (no empty marker)', async () => {
    const cap = createCapturingBus();
    const sess = session();
    // Only plain-text body lines — no JSON meta line, so no session_id is ever extracted.
    const { spawn } = makeProviderSpawn([{ stdoutChunks: ['<task-complete/>\n'], exitCode: 0 }]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.sessionId).toBeUndefined();

    const sidPath = join(dirname(String(sess.signalsFile)), 'session-id.txt');
    await expect(fs.access(sidPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rate-limit: retries up to N times and surfaces RateLimitError when exhausted', async () => {
    const cap = createCapturingBus();
    const rate: SpawnScript = { stderrChunks: ['Error: rate limit exceeded\n'], exitCode: 1 };
    const { spawn } = makeProviderSpawn([rate, rate, rate]);
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

  it('rate-limit on attempt 1, success on attempt 2 → ok (resumes the captured session)', async () => {
    // FINDING 6 — mirror the claude / codex retry-arc. A 429 on attempt 1 must retry and, because
    // the first attempt captured a session id, RESUME it via `--resume <id>` on attempt 2.
    const cap = createCapturingBus();
    const { spawn, calls } = makeProviderSpawn([
      // Attempt 1: captures the session id, then a rate-limit exit.
      {
        stdoutChunks: ['{"session_id":"sess-429","model":"gpt-5.6-sol"}\n'],
        stderrChunks: ['Error: rate limit exceeded\n'],
        exitCode: 1,
      },
      // Attempt 2: clean success resuming the session.
      { stdoutChunks: ['{"session_id":"sess-429","model":"gpt-5.6-sol"}\n', '<task-complete/>\n'], exitCode: 0 },
    ]);

    const provider = createCopilotProvider({
      rateLimitRetries: 2,
      eventBus: cap.bus,
      spawn,
      backoffSchedule: [0, 0, 0],
    });

    const out = await provider.generate(session());
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    // Attempt 1 was a cold start (no --resume).
    expect(calls[0]?.args.some((a) => a.startsWith('--resume'))).toBe(false);
    // Attempt 2 resumes the captured session id (copilot uses the `--resume=<id>` form).
    expect(calls[1]?.args).toContain('--resume=sess-429');
  });

  it('consumes JSON-only assistant delta events without writing signals.json', async () => {
    const cap = createCapturingBus();
    const sess = session();
    const { spawn } = makeProviderSpawn([
      {
        stdoutChunks: [
          '{"session_id":"sess-json","model":"gpt-5.6-sol"}\n',
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
    const { spawn } = makeProviderSpawn([
      {
        stdoutChunks: [
          '{"session_id":"sess-body","model":"gpt-5.6-sol"}\n',
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
    const { spawn } = makeProviderSpawn([
      {
        stdoutChunks: [
          '{"session_id":"sess-empty","model":"gpt-5.6-sol"}\n',
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
    const { spawn, calls } = makeProviderSpawn([
      { stdoutChunks: ['{"session_id":"sess-cwd","model":"gpt-5.6-sol"}\n', '<task-complete/>\n'], exitCode: 0 },
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
    const { spawn } = makeProviderSpawn([
      {
        stdoutChunks: [`{"session_id":"sess-mix","model":"gpt-5.6-sol"}\n${unknownEvt}\n${knownDelta}\n`],
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
    const { spawn } = makeProviderSpawn([
      {
        stdoutChunks: [`{"session_id":"sess-echo","model":"gpt-5.6-sol"}\n${userEcho}\n${assistantTurn}\n`],
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
    const { spawn } = makeProviderSpawn([
      {
        stdoutChunks: ['{"session_id":"sess-clobber","model":"gpt-5.6-sol"}\n', 'fresh body\n'],
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

  it('publishes one assistant debug LogEvent per recognised body line; skips system/malformed; truncates payloads to 120 chars; does not surface tool_use/tool_result (gap documented in adapter header)', async () => {
    const cap = createCapturingBus();
    const sess = session();

    const longText = 'B'.repeat(200);
    const assistantLine = JSON.stringify({
      type: 'assistant.message',
      data: { content: longText },
    });
    // These shapes are NOT recognised by the Copilot parser today — Copilot's stream JSON does
    // not surface structured tool records, per the adapter header comment. The lines pass
    // through onLine but produce no structured per-line debug event.
    const synthToolUse = JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } });
    const synthToolResult = JSON.stringify({ type: 'tool_result', tool: 'Bash', is_error: false, content: 'ok' });
    const systemLine = JSON.stringify({ type: 'system', subtype: 'init', sessionId: 'sess-debug' });
    const malformed = '{not-json-at-all';

    const { spawn } = makeProviderSpawn([
      {
        stdoutChunks: [`${systemLine}\n${assistantLine}\n${synthToolUse}\n${synthToolResult}\n${malformed}\n`],
        exitCode: 0,
      },
    ]);

    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });
    const out = await provider.generate(sess);
    expect(out.ok).toBe(true);

    const assistantEvents = cap.logs.filter((e) => e.level === 'debug' && e.message === 'copilot-provider: assistant');
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents[0]?.meta).toEqual({ text: `${'B'.repeat(120)}…` });

    // tool_use / tool_result analogues are absent in Copilot's stream — assert no structured
    // debug event leaked from the synthetic shapes nor from the system/malformed lines.
    const toolDebugs = cap.logs.filter(
      (e) =>
        e.level === 'debug' &&
        (e.message === 'copilot-provider: tool_use' || e.message === 'copilot-provider: tool_result')
    );
    expect(toolDebugs).toHaveLength(0);
  });
});

describe('createCopilotProvider — TokenUsageEvent emission', () => {
  it('emits one TokenUsageEvent on clean exit even when the meta line lacks usage counters', async () => {
    const cap = createCapturingBus();
    const sess = session();
    // Bare meta line — sessionId + model, no usage object. Honest about missing fields.
    const { spawn } = makeProviderSpawn([
      {
        stdoutChunks: ['{"session_id":"sess-tu","model":"gpt-5.6-sol"}\n', '<task-complete/>\n'],
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
    expect(evt.model).toBe('gpt-5.6-sol');
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
      model: 'gpt-5.6-sol',
      usage: { input_tokens: 444, output_tokens: 222 },
    });
    const { spawn } = makeProviderSpawn([{ stdoutChunks: [`${meta}\n`, '<task-complete/>\n'], exitCode: 0 }]);

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
});

describe('buildCopilotArgs — AiSession → CLI flag translation', () => {
  it.each(COPILOT_MODELS.filter((m) => !isSuspendedModel(m)).map((m) => [m]))('passes through --model=%s', (model) => {
    const args = unwrapArgs(session({ model }));
    expect(args).toContain(`--model=${model}`);
    expect(args).not.toContain('--model');
  });

  it('rejects an unknown model with InvalidStateError', () => {
    const r = buildCopilotArgs(session({ model: 'claude-haiku-4-5' }), PROMPT_FILE_IN_CWD);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'claude-haiku-4-5'");
  });

  it('builds args for the un-suspended claude-fable-5 — the suspension was lifted at GA (2026-07)', () => {
    const args = unwrapArgs(session({ model: 'claude-fable-5' }));
    expect(args).toContain('--model=claude-fable-5');
  });

  it('still builds args for a non-suspended copilot model (claude-opus-4.8)', () => {
    const args = unwrapArgs(session({ model: 'claude-opus-4.8' }));
    expect(args).toContain('--model=claude-opus-4.8');
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

  it('classifies a synchronous spawn throw instead of letting it escape the attempt', async () => {
    // cross-spawn raises an oversized command line synchronously on Windows, and the spawn call
    // used to sit outside any try/catch — the exception escaped runProviderAttempt and would have
    // taken the process down rather than failing the round.
    const cap = createCapturingBus();
    const provider = createCopilotProvider({
      rateLimitRetries: 0,
      eventBus: cap.bus,
      spawn: () => {
        throw Object.assign(new Error('spawn ENAMETOOLONG'), { code: 'ENAMETOOLONG' });
      },
    });

    const out = await provider.generate(session());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toContain('spawn failed');
    expect(out.error.message).toContain('not in argv');
  });

  it('fails the attempt with a StorageError and spawns nothing when the prompt file cannot be written', async () => {
    // The body never rides argv, so an unwritable prompt file is a failed attempt, not an inline fallback.
    const blocker = join(tmpdir(), `ralphctl-copilot-blocker-${String(process.pid)}-${String(Date.now())}`);
    await fs.writeFile(blocker, 'a file where a directory is needed', 'utf8');
    const { spawn, calls } = makeProviderSpawn([{ exitCode: 0 }]);
    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: createCapturingBus().bus, spawn });

    const out = await provider.generate(session({ signalsFile: absolutePath(join(blocker, 'signals.json')) }));

    expect(calls).toHaveLength(0);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('storage-error');
  });

  it('writes the prompt to disk and passes -p a pointer at it, mounting its directory', async () => {
    // Copilot is the one CLI with no stdin prompt path, so the body used to ride argv — which
    // capped every headless run at the platform command line and died as `spawn ENAMETOOLONG`
    // on Windows.
    const cap = createCapturingBus();
    const sess = session();
    const { spawn, calls } = makeProviderSpawn([{ stdoutChunks: ['{"session_id":"sess-1"}\n'], exitCode: 0 }]);
    const provider = createCopilotProvider({ rateLimitRetries: 0, eventBus: cap.bus, spawn });

    await provider.generate(sess);

    const promptFile = join(dirname(String(sess.signalsFile)), 'copilot-prompt.md');
    await expect(fs.readFile(promptFile, 'utf8')).resolves.toBe(PROMPT as unknown as string);

    const args = calls[0]!.args;
    const idx = args.indexOf('-p');
    expect(args[idx + 1]).toContain(promptFile);
    expect(args).not.toContain(PROMPT as unknown as string);
    expect(args).toContain(`--add-dir=${dirname(promptFile)}`);
  });
});
