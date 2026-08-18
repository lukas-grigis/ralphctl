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
import { buildOpencodeArgs, createOpencodeProvider } from '@src/integration/ai/providers/opencode/headless.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import type { LogEvent, TokenUsageEvent } from '@src/business/observability/events.ts';

interface FakeChildScript {
  readonly stdoutChunks?: readonly string[];
  readonly stderrChunks?: readonly string[];
  readonly exitCode?: number | null;
}

const makeStream = (): EventEmitter & { setEncoding: (e: string) => void } => {
  const ee = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  ee.setEncoding = (): void => {};
  return ee;
};

const makeFakeChild = (script: FakeChildScript): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = makeStream();
  const stderr = makeStream();
  Object.assign(child, {
    stdout,
    stderr,
    stdin: {
      end(_data?: unknown): void {
        void _data;
      },
    },
    kill(): boolean {
      setTimeout(() => child.emit('exit', null, 'SIGTERM'), 0);
      return true;
    },
  });
  setTimeout(() => {
    for (const chunk of script.stdoutChunks ?? []) stdout.emit('data', chunk);
    for (const chunk of script.stderrChunks ?? []) stderr.emit('data', chunk);
    setTimeout(() => child.emit('exit', script.exitCode ?? 0, null), 0);
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
const CWD = absolutePath('/tmp/opencode-provider-test');
const MODEL = 'opencode/big-pickle';

let signalsCounter = 0;
const tempSignalsFile = () => {
  signalsCounter += 1;
  return absolutePath(
    join(
      tmpdir(),
      `ralphctl-opencode-test-${String(process.pid)}-${String(Date.now())}-${String(signalsCounter)}`,
      'signals.json'
    )
  );
};

let bodyCounter = 0;
const tempBodyFile = () => {
  bodyCounter += 1;
  return absolutePath(
    join(tmpdir(), `ralphctl-opencode-body-${String(process.pid)}-${String(Date.now())}-${String(bodyCounter)}.txt`)
  );
};

const session = (overrides: Partial<AiSession> = {}): AiSession => ({
  prompt: PROMPT,
  cwd: CWD,
  model: MODEL,
  permissions: READ_ONLY,
  signalsFile: tempSignalsFile(),
  ...overrides,
});

/** Build the JSONL records the real CLI emits, so parser tests track the observed shape. */
const stepStart = (sid: string): string =>
  `{"type":"step_start","timestamp":1,"sessionID":"${sid}","part":{"type":"step-start"}}\n`;
const textLine = (sid: string, text: string): string =>
  `{"type":"text","timestamp":2,"sessionID":"${sid}","part":{"type":"text","text":${JSON.stringify(text)}}}\n`;
const toolLine = (sid: string, tool: string, status: string): string =>
  `{"type":"tool_use","timestamp":3,"sessionID":"${sid}","part":{"type":"tool","tool":"${tool}","callID":"call_1","state":{"status":"${status}","input":{"filePath":"/x"},"output":"done"}}}\n`;
const stepFinish = (sid: string, input: number, output: number): string =>
  `{"type":"step_finish","timestamp":4,"sessionID":"${sid}","part":{"type":"step-finish","reason":"stop","tokens":{"total":999,"input":${String(input)},"output":${String(output)},"reasoning":0,"cache":{"read":0,"write":0}},"cost":0}}\n`;

const writeSignals = async (path: string): Promise<void> => {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify({ status: 'complete', summary: 'ok' }), 'utf8');
};

describe('buildOpencodeArgs', () => {
  it('builds the base argv with format, dir and model', () => {
    const built = buildOpencodeArgs(session());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value).toEqual(['run', '--format', 'json', '--dir', String(CWD), '-m', MODEL]);
  });

  it('passes the resume id via -s', () => {
    const built = buildOpencodeArgs(session({ resume: 'ses_abc123' as unknown as SessionId }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value).toContain('-s');
    expect(built.value[built.value.indexOf('-s') + 1]).toBe('ses_abc123');
  });

  it('maps effort onto --variant', () => {
    const built = buildOpencodeArgs(session({ effort: 'high' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value[built.value.indexOf('--variant') + 1]).toBe('high');
  });

  it('adds --auto for auto-approving profiles, and omits it when every root is inside cwd', () => {
    const auto = buildOpencodeArgs(session({ permissions: FULL_AUTO, outputDir: CWD }));
    const manual = buildOpencodeArgs(session({ permissions: READ_ONLY, outputDir: CWD }));
    expect(auto.ok && auto.value.includes('--auto')).toBe(true);
    expect(manual.ok && manual.value.includes('--auto')).toBe(false);
  });

  it('adds --auto for a READ_ONLY session whose outputDir sits outside cwd', () => {
    // `opencode run` gates any access outside `--dir` behind the `external_directory`
    // permission and auto-rejects it, so without `--auto` the audit-[09] envelope never lands
    // and every READ_ONLY flow fails downstream with `signals-missing`.
    const built = buildOpencodeArgs(
      session({ permissions: READ_ONLY, outputDir: absolutePath('/tmp/opencode-outside/run-1') })
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.filter((a) => a === '--auto')).toHaveLength(1);
  });

  it('emits --auto exactly once when both autoApprove and an external root apply', () => {
    const built = buildOpencodeArgs(
      session({ permissions: FULL_AUTO, outputDir: absolutePath('/tmp/opencode-outside/run-2') })
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.filter((a) => a === '--auto')).toHaveLength(1);
  });

  it('rejects a bare model id that is missing the provider namespace', () => {
    const built = buildOpencodeArgs(session({ model: 'gpt-5.5' }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.message).toContain("'provider/model'");
  });

  it('accepts an off-catalog id from an authenticated upstream provider', () => {
    // OpenCode is an aggregator: catalog membership is NOT the gate, only id shape is.
    const built = buildOpencodeArgs(session({ model: 'anthropic/claude-sonnet-4-5' }));
    expect(built.ok).toBe(true);
  });
});

describe('createOpencodeProvider', () => {
  it('captures the session id off the stream and returns the accumulated body', async () => {
    const sid = 'ses_01fc2cbe1ffeXgUcoySQcdO14d';
    const { spawn, calls } = makeSpawn([
      { stdoutChunks: [stepStart(sid), textLine(sid, 'first'), textLine(sid, 'second'), stepFinish(sid, 10, 5)] },
    ]);
    const bus = createCapturingBus();
    const bodyFile = tempBodyFile();
    const s = session({ bodyFile });
    await writeSignals(String(s.signalsFile));

    const result = await createOpencodeProvider({ rateLimitRetries: 0, eventBus: bus.bus, spawn }).generate(s);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe(sid);
    expect(await fs.readFile(String(bodyFile), 'utf8')).toBe('first\nsecond');
    expect(calls[0]?.command).toBe('opencode');
  });

  it('sums per-step token usage rather than reading the cumulative total', async () => {
    const sid = 'ses_sum';
    // Two steps of 10/5 each. `total` on each record says 999 — reading it would be wrong;
    // the adapter must report 20 input / 10 output.
    const { spawn } = makeSpawn([
      {
        stdoutChunks: [
          stepStart(sid),
          toolLine(sid, 'write', 'completed'),
          stepFinish(sid, 10, 5),
          textLine(sid, 'done'),
          stepFinish(sid, 10, 5),
        ],
      },
    ]);
    const bus = createCapturingBus();
    const s = session();
    await writeSignals(String(s.signalsFile));

    await createOpencodeProvider({ rateLimitRetries: 0, eventBus: bus.bus, spawn }).generate(s);

    const usage = bus.events.find((e): e is TokenUsageEvent => e.type === 'token-usage');
    expect(usage?.provider).toBe('opencode');
    expect(usage?.inputTokens).toBe(20);
    expect(usage?.outputTokens).toBe(10);
  });

  it('falls back to a cold spawn when the resume id is stale', async () => {
    const sid = 'ses_fresh';
    const s = session({ resume: 'ses_gone' as unknown as SessionId });
    const inner = makeSpawn([
      { stderrChunks: ['Error: Session not found\n'], exitCode: 1 },
      { stdoutChunks: [stepStart(sid), textLine(sid, 'recovered'), stepFinish(sid, 1, 1)] },
    ]);
    // signals.json must NOT exist for the first attempt: a non-zero exit WITH the envelope
    // already on disk is the audit-[09] "recovered" path, which would report success and never
    // reach the stale-resume branch. It appears only once the cold retry spawns.
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawn: ProviderSpawn = (command, args, options) => {
      calls.push({ command, args });
      if (calls.length === 2) void writeSignals(String(s.signalsFile));
      return inner.spawn(command, args, options);
    };
    const bus = createCapturingBus();

    const result = await createOpencodeProvider({ rateLimitRetries: 0, eventBus: bus.bus, spawn }).generate(s);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    // First attempt carries -s; the cold retry must drop it entirely.
    expect(calls[0]?.args).toContain('-s');
    expect(calls[1]?.args).not.toContain('-s');
  });

  it('surfaces the stdout error record in the failure message and as a warn log (empty stderr)', async () => {
    // An unreachable / unauthenticated `provider/model` id makes `opencode run` exit 1 with an
    // EMPTY stderr and its whole explanation on a stdout `{"type":"error"}` record. That text used
    // to be parsed and dropped, leaving `process exited with code 1: <empty stderr>` — a failure
    // an operator cannot act on, repeated for every attempt in the budget.
    const errorLine =
      '{"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Please try again."}}}\n';
    const { spawn } = makeSpawn([{ stdoutChunks: [errorLine], exitCode: 1 }]);
    const bus = createCapturingBus();
    // No signals.json — the CLI never got far enough to land one.
    const result = await createOpencodeProvider({ rateLimitRetries: 0, eventBus: bus.bus, spawn }).generate(session());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('UnknownError: Unexpected server error');
    expect(result.error.message).not.toContain('<empty stderr>');
    // …and the same explanation is visible per attempt at warn level, not buried at debug.
    expect(
      bus.logs.some((l) => l.level === 'warn' && l.message.includes('UnknownError: Unexpected server error'))
    ).toBe(true);
  });

  it('tolerates non-JSON banner lines interleaved with the stream', async () => {
    const sid = 'ses_noise';
    const { spawn } = makeSpawn([
      { stdoutChunks: ['[91mwarning: something[0m\n', stepStart(sid), textLine(sid, 'body'), stepFinish(sid, 1, 1)] },
    ]);
    const bus = createCapturingBus();
    const bodyFile = tempBodyFile();
    const s = session({ bodyFile });
    await writeSignals(String(s.signalsFile));

    const result = await createOpencodeProvider({ rateLimitRetries: 0, eventBus: bus.bus, spawn }).generate(s);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe(sid);
    expect(await fs.readFile(String(bodyFile), 'utf8')).toBe('body');
  });

  it('fans one resolved tool_use record out to both a tool_use and a tool_result debug event', async () => {
    // OpenCode resolves tool calls in place — there is no separate result record — so a single
    // `tool_use` line has to produce both halves of the debug trace, and a non-`completed`
    // status has to surface as `status: 'error'`.
    const sid = 'ses_tools';
    const { spawn } = makeSpawn([
      {
        stdoutChunks: [
          stepStart(sid),
          toolLine(sid, 'write', 'completed'),
          toolLine(sid, 'bash', 'error'),
          stepFinish(sid, 1, 1),
        ],
      },
    ]);
    const bus = createCapturingBus();
    const s = session();
    await writeSignals(String(s.signalsFile));

    const result = await createOpencodeProvider({ rateLimitRetries: 0, eventBus: bus.bus, spawn }).generate(s);
    expect(result.ok).toBe(true);

    const toolEvents = bus.events.filter(
      (e): e is LogEvent =>
        e.type === 'log' &&
        (e.message === 'opencode-provider: tool_use' || e.message === 'opencode-provider: tool_result')
    );
    expect(toolEvents).toHaveLength(4);

    const writeUse = toolEvents.find(
      (e) => e.message === 'opencode-provider: tool_use' && e.meta?.['tool'] === 'write'
    );
    expect(writeUse?.meta?.['args']).toBe(JSON.stringify({ filePath: '/x' }));

    const writeResult = toolEvents.find(
      (e) => e.message === 'opencode-provider: tool_result' && e.meta?.['tool'] === 'write'
    );
    expect(writeResult?.meta?.['status']).toBe('ok');
    expect(writeResult?.meta?.['preview']).toBe('done');

    const bashResult = toolEvents.find(
      (e) => e.message === 'opencode-provider: tool_result' && e.meta?.['tool'] === 'bash'
    );
    expect(bashResult?.meta?.['status']).toBe('error');
  });

  it('flushes a trailing record that arrives without a newline', async () => {
    const sid = 'ses_tail';
    const noNewline = textLine(sid, 'tail').trimEnd();
    const { spawn } = makeSpawn([{ stdoutChunks: [stepStart(sid), noNewline] }]);
    const bus = createCapturingBus();
    const bodyFile = tempBodyFile();
    const s = session({ bodyFile });
    await writeSignals(String(s.signalsFile));

    const result = await createOpencodeProvider({ rateLimitRetries: 0, eventBus: bus.bus, spawn }).generate(s);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await fs.readFile(String(bodyFile), 'utf8')).toBe('tail');
  });
});
