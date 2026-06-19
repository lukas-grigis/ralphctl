import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { classifySpawnExit, type ProviderName } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';

const PROMPT = 'fake prompt' as unknown as Prompt;
const CWD = absolutePath('/tmp/classify-spawn-exit-test');

let counter = 0;
const freshSignalsPath = (): string => {
  counter += 1;
  return join(
    tmpdir(),
    `classify-spawn-exit-${String(process.pid)}-${String(Date.now())}-${String(counter)}`,
    'signals.json'
  );
};

const writeSignalsFile = async (path: string, content = '{}'): Promise<void> => {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, 'utf8');
};

const baseSession = (overrides: Partial<AiSession> = {}): AiSession => ({
  prompt: PROMPT,
  cwd: CWD,
  model: 'fake-model',
  permissions: READ_ONLY,
  signalsFile: absolutePath(freshSignalsPath()),
  ...overrides,
});

const happyOutput = (session: AiSession): ProviderOutput => ({
  signalsFile: session.signalsFile,
  exitCode: 0,
  sessionId: 'fake-session',
});

const okSuccess = (session: AiSession): AttemptOutcome => ({
  kind: 'success',
  output: happyOutput(session),
});

const RATE_RE = /rate.?limit/i;

// Parametric across the three real providers — keeps the shape honest. The helper itself
// doesn't care which provider name; tests asserting the message text only need ONE pick.
const PROVIDERS: readonly ProviderName[] = ['claude-provider', 'codex-provider', 'copilot-provider'];

describe.each(PROVIDERS)('classifySpawnExit [%s]', (providerName) => {
  it('clean exit invokes onSuccess and does not set recoveredFromExit', async () => {
    const session = baseSession();
    const cap = createCapturingBus();
    let invoked = 0;
    const outcome = await classifySpawnExit({
      session,
      exit: { code: 0, signal: null },
      stderr: '',
      rateLimitRe: RATE_RE,
      providerName,
      eventBus: cap.bus,
      watchdogBannerId: 'unused',
      onSuccess: () => {
        invoked += 1;
        return okSuccess(session);
      },
    });
    expect(invoked).toBe(1);
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.output.recoveredFromExit).toBeUndefined();
    }
  });

  it('aborted signal + SIGTERM returns AbortError (not InvalidStateError)', async () => {
    const ac = new AbortController();
    ac.abort();
    const session = baseSession({ abortSignal: ac.signal });
    let invoked = 0;
    const outcome = await classifySpawnExit({
      session,
      exit: { code: null, signal: 'SIGTERM' },
      stderr: '',
      rateLimitRe: RATE_RE,
      providerName,
      eventBus: createCapturingBus().bus,
      watchdogBannerId: 'unused',
      onSuccess: () => {
        invoked += 1;
        return okSuccess(session);
      },
    });
    expect(invoked).toBe(0);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error).toBeInstanceOf(AbortError);
      expect(outcome.error.message).toContain(providerName);
    }
  });

  it('aborted signal + clean exit returns AbortError (precedence over success)', async () => {
    const ac = new AbortController();
    ac.abort();
    const session = baseSession({ abortSignal: ac.signal });
    const outcome = await classifySpawnExit({
      session,
      exit: { code: 0, signal: null },
      stderr: '',
      rateLimitRe: RATE_RE,
      providerName,
      eventBus: createCapturingBus().bus,
      watchdogBannerId: 'unused',
      onSuccess: () => okSuccess(session),
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.error).toBeInstanceOf(AbortError);
  });

  it('SIGTERM + signals.json present invokes onSuccess and sets recoveredFromExit', async () => {
    const session = baseSession();
    await writeSignalsFile(String(session.signalsFile));
    const cap = createCapturingBus();
    let invoked = 0;
    const outcome = await classifySpawnExit({
      session,
      exit: { code: null, signal: 'SIGTERM' },
      stderr: '',
      rateLimitRe: RATE_RE,
      providerName,
      eventBus: cap.bus,
      watchdogBannerId: 'watchdog-test-pid-1234',
      onSuccess: () => {
        invoked += 1;
        return okSuccess(session);
      },
    });
    expect(invoked).toBe(1);
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.output.recoveredFromExit).toEqual({ code: null, signal: 'SIGTERM' });
    }
    // Recovery emits a warn log + a banner-clear for the watchdog banner.
    const warnLog = cap.logs.find((e) => e.level === 'warn');
    expect(warnLog).toBeDefined();
    if (warnLog !== undefined) {
      expect(warnLog.message).toContain('signals.json captured');
      expect(warnLog.message).toContain(providerName);
    }
    const bannerClear = cap.events.find((e) => e.type === 'banner-clear');
    expect(bannerClear).toBeDefined();
    if (bannerClear?.type === 'banner-clear') {
      expect(bannerClear.id).toBe('watchdog-test-pid-1234');
    }
  });

  it('code 143 + signal null + signals.json present recovers (macOS Node shape)', async () => {
    const session = baseSession();
    await writeSignalsFile(String(session.signalsFile));
    const outcome = await classifySpawnExit({
      session,
      exit: { code: 143, signal: null },
      stderr: '',
      rateLimitRe: RATE_RE,
      providerName,
      eventBus: createCapturingBus().bus,
      watchdogBannerId: 'unused',
      onSuccess: () => okSuccess(session),
    });
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.output.recoveredFromExit).toEqual({ code: 143, signal: null });
    }
  });

  it('non-zero exit + signals.json absent hard-fails with InvalidStateError', async () => {
    const session = baseSession();
    // Do NOT write signals.json.
    let invoked = 0;
    const outcome = await classifySpawnExit({
      session,
      exit: { code: 2, signal: null },
      stderr: 'some-real-failure',
      rateLimitRe: RATE_RE,
      providerName,
      eventBus: createCapturingBus().bus,
      watchdogBannerId: 'unused',
      onSuccess: () => {
        invoked += 1;
        return okSuccess(session);
      },
    });
    expect(invoked).toBe(0);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error).toBeInstanceOf(InvalidStateError);
      expect(outcome.error.message).toContain('process exited with code 2');
      expect(outcome.error.message).toContain('some-real-failure');
    }
  });

  it('non-zero exit + empty signals.json still recovers (adapter does not validate content)', async () => {
    const session = baseSession();
    // Write an empty file — downstream validate-signals-file.ts catches malformed content;
    // the adapter intentionally only checks existence so that split stays clean.
    await writeSignalsFile(String(session.signalsFile), '');
    let invoked = 0;
    const outcome = await classifySpawnExit({
      session,
      exit: { code: 1, signal: null },
      stderr: 'partial-write-then-crash',
      rateLimitRe: RATE_RE,
      providerName,
      eventBus: createCapturingBus().bus,
      watchdogBannerId: 'unused',
      onSuccess: () => {
        invoked += 1;
        return okSuccess(session);
      },
    });
    expect(invoked).toBe(1);
    expect(outcome.kind).toBe('success');
  });

  it('spawn error maps to InvalidStateError before any exit-code branch (missing binary)', async () => {
    // FINDING 1 — a spawn `'error'` event (ENOENT / EACCES) means the child never ran; classify
    // it as a typed, actionable failure before the clean-exit / rate-limit branches. The errno
    // and message must surface so the operator knows the CLI is missing.
    const session = baseSession();
    const spawnError = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException;
    let invoked = 0;
    const outcome = await classifySpawnExit({
      session,
      exit: { code: null, signal: null, spawnError },
      stderr: '',
      rateLimitRe: RATE_RE,
      providerName,
      eventBus: createCapturingBus().bus,
      watchdogBannerId: 'unused',
      onSuccess: () => {
        invoked += 1;
        return okSuccess(session);
      },
    });
    expect(invoked).toBe(0);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error).toBeInstanceOf(InvalidStateError);
      expect(outcome.error.message).toContain('spawn failed');
      expect(outcome.error.message).toContain('ENOENT');
      expect(outcome.error.message).toContain(providerName);
    }
  });

  it('rate-limit detected in stdoutTail (not stderr) when the provider reports quota on stdout', async () => {
    // FINDING 3 — claude's `-p stream-json` mode reports quota in the stdout result envelope, not
    // on stderr. The classifier must scan stderr + stdoutTail so the throttle trips the backoff.
    const session = baseSession();
    await writeSignalsFile(String(session.signalsFile));
    const outcome = await classifySpawnExit({
      session,
      exit: { code: 1, signal: null },
      stderr: '',
      stdoutTail: '{"type":"result","subtype":"error_max_turns","result":"usage limit reached"}',
      rateLimitRe: /rate.?limit|usage limit reached|429/i,
      capturedSessionId: 'sess-stdout',
      providerName,
      eventBus: createCapturingBus().bus,
      watchdogBannerId: 'unused',
      onSuccess: () => okSuccess(session),
    });
    expect(outcome.kind).toBe('rate-limit');
    if (outcome.kind === 'rate-limit') {
      expect(outcome.error.sessionId).toBe('sess-stdout');
    }
  });

  // Representative model-unavailable stderr strings observed across the three real CLIs.
  const MODEL_UNAVAILABLE_STDERR: readonly string[] = [
    'Error: Model "gpt-5.4-nano" from --model flag is not available.',
    'model claude-opus-9 not found',
    'unknown model: o5-mega',
    'unsupported model requested',
  ];

  it.each(MODEL_UNAVAILABLE_STDERR)(
    'model-unavailable stderr maps to InvalidStateError with actionable hint (%s)',
    async (stderr) => {
      const session = baseSession();
      // No signals.json — and even if there were one, the model branch wins over recovery.
      let invoked = 0;
      const outcome = await classifySpawnExit({
        session,
        exit: { code: 1, signal: null },
        stderr,
        rateLimitRe: RATE_RE,
        providerName,
        eventBus: createCapturingBus().bus,
        watchdogBannerId: 'unused',
        onSuccess: () => {
          invoked += 1;
          return okSuccess(session);
        },
      });
      expect(invoked).toBe(0);
      expect(outcome.kind).toBe('error');
      if (outcome.kind === 'error') {
        expect(outcome.error).toBeInstanceOf(InvalidStateError);
        // Raw stderr detail is preserved …
        expect(outcome.error.message).toContain(stderr);
        // … alongside the actionable hint, folded into `.message` so it survives to the UI.
        expect(outcome.error.message).toContain('model not available');
        expect(outcome.error.message).toContain('pick another model in settings');
        // Separate `.hint` field is also populated.
        expect((outcome.error as InvalidStateError).hint).toContain('pick another model in settings');
      }
    }
  );

  it('model-unavailable wins over signals-present recovery (config error, not recoverable work)', async () => {
    const session = baseSession();
    await writeSignalsFile(String(session.signalsFile));
    let invoked = 0;
    const outcome = await classifySpawnExit({
      session,
      exit: { code: 1, signal: null },
      stderr: 'Error: Model "gpt-5.4-nano" from --model flag is not available.',
      rateLimitRe: RATE_RE,
      providerName,
      eventBus: createCapturingBus().bus,
      watchdogBannerId: 'unused',
      onSuccess: () => {
        invoked += 1;
        return okSuccess(session);
      },
    });
    expect(invoked).toBe(0);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error).toBeInstanceOf(InvalidStateError);
      expect(outcome.error.message).toContain('model not available');
    }
  });

  it('model-unavailable wording ONLY in stdoutTail does NOT classify as model-unavailable (false-positive guard)', async () => {
    // stdoutTail carries assistant-generated task output, where benign phrases like "the model is
    // not available in TensorFlow" appear in NORMAL responses. The model-unavailable branch scans
    // stderr ONLY — a model-availability phrase that lands solely in stdoutTail (with a generic
    // non-zero exit and unrelated stderr) must fall through to the generic hard-fail branch, NOT be
    // misclassified as a config failure. All three CLIs report real model errors on stderr.
    const session = baseSession();
    const outcome = await classifySpawnExit({
      session,
      exit: { code: 1, signal: null },
      stderr: '',
      stdoutTail: '{"type":"result","result":"the model is not available in TensorFlow yet"}',
      rateLimitRe: RATE_RE,
      providerName,
      eventBus: createCapturingBus().bus,
      watchdogBannerId: 'unused',
      onSuccess: () => okSuccess(session),
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error).toBeInstanceOf(InvalidStateError);
      // Falls through to generic hard-fail — the model hint must NOT appear.
      expect(outcome.error.message).not.toContain('pick another model in settings');
      expect(outcome.error.message).toContain('process exited with code 1');
    }
  });

  it('generic non-zero failure (not model-related) does NOT trip the model hint', async () => {
    const session = baseSession();
    const outcome = await classifySpawnExit({
      session,
      exit: { code: 2, signal: null },
      stderr: 'TypeError: cannot read property of undefined',
      rateLimitRe: RATE_RE,
      providerName,
      eventBus: createCapturingBus().bus,
      watchdogBannerId: 'unused',
      onSuccess: () => okSuccess(session),
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error).toBeInstanceOf(InvalidStateError);
      expect(outcome.error.message).not.toContain('pick another model in settings');
    }
  });

  it('rate-limit in stderr wins over signals-present recovery', async () => {
    const session = baseSession();
    await writeSignalsFile(String(session.signalsFile));
    let invoked = 0;
    const outcome = await classifySpawnExit({
      session,
      exit: { code: 1, signal: null },
      stderr: 'rate limit exceeded for tier x',
      rateLimitRe: RATE_RE,
      capturedSessionId: 'fake-id',
      providerName,
      eventBus: createCapturingBus().bus,
      watchdogBannerId: 'unused',
      onSuccess: () => {
        invoked += 1;
        return okSuccess(session);
      },
    });
    expect(invoked).toBe(0);
    expect(outcome.kind).toBe('rate-limit');
    if (outcome.kind === 'rate-limit') {
      expect(outcome.error).toBeInstanceOf(RateLimitError);
      expect(outcome.error.sessionId).toBe('fake-id');
    }
  });
});
