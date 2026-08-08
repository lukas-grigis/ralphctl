import { EventEmitter } from 'node:events';
import { mkdtemp, readFile as readFileFs, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import type { InteractiveSpawn } from '@src/integration/ai/providers/_engine/interactive-spawn.ts';
import { argvByteLength } from '@src/integration/ai/providers/_engine/argv-budget.ts';
import {
  createInteractiveProvider,
  type InteractiveProviderSpec,
} from '@src/integration/ai/providers/_engine/run-interactive-session.ts';

// `SUSPENDED_MODELS` ships empty, so the suspension arm of `validateModel` is unreachable with the
// real catalog — mock it to exercise the guard without waiting for a real suspension incident.
vi.mock('@src/domain/value/settings-models/suspended-models.ts', () => ({
  isSuspendedModel: (s: string) => s === 'suspended-model',
  suspendedModelMessage: (m: string) => `'${m}' is temporarily suspended by its provider`,
}));

interface CapturingSpawnState {
  readonly spawn: InteractiveSpawn;
  readonly calls: ReadonlyArray<{ readonly command: string; readonly args: readonly string[]; readonly cwd: string }>;
  readonly emitExit: (code: number | null) => void;
  readonly emitError: (cause: Error) => void;
}

const makeSpawn = (): CapturingSpawnState => {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const last = {
    child: undefined as (ChildProcess & { emit: (event: string, ...args: unknown[]) => boolean }) | undefined,
  };
  const spawn: InteractiveSpawn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    const child = new EventEmitter() as unknown as ChildProcess & {
      emit: (event: string, ...args: unknown[]) => boolean;
    };
    // `attachAbortKill` calls `child.kill` on abort — the fake needs it to be callable.
    (child as unknown as { kill: () => boolean }).kill = (): boolean => true;
    last.child = child;
    return child;
  };
  return {
    spawn,
    calls,
    emitExit: (code) => {
      setTimeout(() => last.child?.emit('close', code), 0);
    },
    emitError: (cause) => {
      setTimeout(() => last.child?.emit('error', cause), 0);
    },
  };
};

const STUB_PROMPT = 'Do the thing.';
const stubReadFile = (): Promise<string> => Promise.resolve(STUB_PROMPT);

const PROMPT_FILE = absolutePath('/tmp/engine-prompt.md');
const OUTPUT_FILE = absolutePath('/tmp/engine-output.md');
const CWD = absolutePath('/tmp/engine-cwd');
const MODEL = 'known-model';

/** Minimal stand-in CLI so the shared skeleton is exercised without a real provider catalog. */
const spec = (overrides: Partial<InteractiveProviderSpec> = {}): InteractiveProviderSpec => ({
  providerName: 'interactive-stub',
  defaultCommand: 'stub-cli',
  modelCatalogLabel: 'Stub',
  isKnownModel: (m) => m === MODEL || m === 'suspended-model',
  supportsSessionId: true,
  mountsRoots: true,
  buildArgs: (input, { promptArg, roots, sessionId }) => [
    ...roots.flatMap((p) => ['--add-dir', p]),
    '--model',
    input.model,
    ...(sessionId !== undefined ? ['--session-id', sessionId] : []),
    promptArg,
  ],
  ...overrides,
});

const tempDirs: string[] = [];
const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ralphctl-interactive-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe('createInteractiveProvider', () => {
  it('rejects an unknown model with InvalidStateError, without spawning', async () => {
    const cap = createCapturingBus();
    const { spawn, calls } = makeSpawn();
    const provider = createInteractiveProvider(spec(), { eventBus: cap.bus, spawn, readFile: stubReadFile });

    const r = await provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: 'nope' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toBe("interactive-stub: 'nope' is not a known Stub model");
    expect(calls).toHaveLength(0);
  });

  it('rejects a suspended-but-catalog-known model with InvalidStateError, without spawning', async () => {
    const cap = createCapturingBus();
    const { spawn, calls } = makeSpawn();
    const provider = createInteractiveProvider(spec(), { eventBus: cap.bus, spawn, readFile: stubReadFile });

    const r = await provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: 'suspended-model',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain('temporarily suspended');
    expect(calls).toHaveLength(0);
  });

  it('returns StorageError when the prompt file cannot be read, without spawning', async () => {
    const cap = createCapturingBus();
    const { spawn, calls } = makeSpawn();
    const provider = createInteractiveProvider(spec(), {
      eventBus: cap.bus,
      spawn,
      readFile: () => Promise.reject(new Error('ENOENT: no such file')),
    });

    const r = await provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('storage-error');
    expect(r.error.message).toContain('failed to read prompt file');
    expect(r.error.message).toContain('ENOENT: no such file');
    expect(calls).toHaveLength(0);
  });

  it('returns StorageError when the spawn itself throws', async () => {
    const cap = createCapturingBus();
    const throwingSpawn: InteractiveSpawn = () => {
      throw new Error('spawn stub-cli ENOENT');
    };
    const provider = createInteractiveProvider(spec(), {
      eventBus: cap.bus,
      spawn: throwingSpawn,
      readFile: stubReadFile,
    });

    const r = await provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('storage-error');
    expect(r.error.message).toContain('failed to spawn');
    expect(r.error.message).toContain('spawn stub-cli ENOENT');
  });

  it('returns InvalidStateError when the session exits non-zero', async () => {
    const cap = createCapturingBus();
    const { spawn, emitExit } = makeSpawn();
    const provider = createInteractiveProvider(spec(), { eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    emitExit(9);
    const r = await runPromise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain('session exited with code 9');
  });

  it('returns AbortError (not InvalidStateError) when aborted before a non-zero exit', async () => {
    // A TUI cancel fires: attachAbortKill SIGTERMs the stdio-inherit child, which exits non-zero.
    // The engine must classify this as AbortError — the one error chains propagate transparently —
    // not the generic session-exit InvalidStateError a downstream guard could catch and continue.
    const cap = createCapturingBus();
    const { spawn, emitExit } = makeSpawn();
    const provider = createInteractiveProvider(spec(), { eventBus: cap.bus, spawn, readFile: stubReadFile });
    const controller = new AbortController();

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: MODEL,
      abortSignal: controller.signal,
    });
    controller.abort();
    emitExit(143);
    const r = await runPromise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('aborted');
    expect(r.error.name).toBe('AbortError');
  });

  it('folds duplicate roots and orders them cwd, additionalRoots, output dir, prompt dir', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveProvider(spec(), { eventBus: cap.bus, spawn, readFile: stubReadFile });

    const extraRepo = absolutePath('/tmp/engine-sibling-repo');
    const runPromise = provider.run({
      cwd: CWD,
      additionalRoots: [extraRepo, CWD],
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: MODEL,
    });
    emitExit(0);
    await runPromise;

    const args = calls[0]!.args;
    const roots = args.filter((_, i) => args[i - 1] === '--add-dir');
    // dirname(promptFile) === dirname(outputFile) === '/tmp' → one entry; CWD listed twice → one.
    expect(roots).toEqual([String(CWD), String(extraRepo), '/tmp']);
  });

  it('pre-generates a session id, passes it to the CLI, and mirrors it next to the output file', async () => {
    const dir = await makeTempDir();
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveProvider(spec(), {
      eventBus: cap.bus,
      spawn,
      readFile: stubReadFile,
      newSessionId: () => 'fixed-session-id',
    });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: absolutePath(join(dir, 'prompt.md')),
      outputFile: absolutePath(join(dir, 'requirements.md')),
      model: MODEL,
    });
    emitExit(0);
    const r = await runPromise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionId).toBe('fixed-session-id');
    expect(calls[0]!.args).toContain('fixed-session-id');
    await expect(readFileFs(join(dir, 'session-id.txt'), 'utf8')).resolves.toBe('fixed-session-id\n');
  });

  it('leaves the session id unset and writes no sidechannel file when the CLI has no launch-time override', async () => {
    const dir = await makeTempDir();
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveProvider(spec({ supportsSessionId: false }), {
      eventBus: cap.bus,
      spawn,
      readFile: stubReadFile,
      newSessionId: () => 'fixed-session-id',
    });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: absolutePath(join(dir, 'prompt.md')),
      outputFile: absolutePath(join(dir, 'requirements.md')),
      model: MODEL,
    });
    emitExit(0);
    const r = await runPromise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionId).toBeUndefined();
    expect(calls[0]!.args).not.toContain('fixed-session-id');
    await expect(readFileFs(join(dir, 'session-id.txt'), 'utf8')).rejects.toThrow();
  });

  it('passes a pointer at the prompt file, never the prompt body', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveProvider(spec(), { eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    emitExit(0);
    await runPromise;

    const args = calls[0]!.args;
    expect(args.at(-1)).toContain(String(PROMPT_FILE));
    expect(args).not.toContain(STUB_PROMPT);
  });

  it('keeps argv small no matter how large the prompt is', async () => {
    // The regression that motivated the pointer: a rendered plan prompt blew the 32,767-byte
    // Windows command line and the session died with `spawn ENAMETOOLONG` before the CLI started.
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const hugePrompt = 'x'.repeat(200_000);
    const provider = createInteractiveProvider(spec(), {
      eventBus: cap.bus,
      spawn,
      readFile: () => Promise.resolve(hugePrompt),
    });

    const runPromise = provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    emitExit(0);
    await runPromise;

    const call = calls[0]!;
    expect(argvByteLength(call.command, call.args)).toBeLessThan(2_000);
  });

  it('falls back to the inlined body, with a warning, when the CLI cannot reach the prompt file', async () => {
    // OpenCode's shape: no `--add-dir`, so only a prompt file under `cwd` is readable. Handing it
    // an unreachable path would open a session that silently has no instructions — worse than a
    // large argv, which at least fails loudly.
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveProvider(spec({ mountsRoots: false }), {
      eventBus: cap.bus,
      spawn,
      readFile: stubReadFile,
    });

    const runPromise = provider.run({
      cwd: absolutePath('/tmp/some-repo'),
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: MODEL,
    });
    emitExit(0);
    await runPromise;

    expect(calls[0]!.args).toContain(STUB_PROMPT);
    expect(cap.logs.map((e) => e.message).join('\n')).toContain('passing the prompt inline');
  });

  it('uses the pointer for a root-less CLI when the prompt file sits under cwd', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveProvider(spec({ mountsRoots: false }), {
      eventBus: cap.bus,
      spawn,
      readFile: stubReadFile,
    });

    const promptFile = absolutePath(join(String(CWD), 'prompt.md'));
    const runPromise = provider.run({ cwd: CWD, promptFile, outputFile: OUTPUT_FILE, model: MODEL });
    emitExit(0);
    await runPromise;

    expect(calls[0]!.args.at(-1)).toContain(String(promptFile));
    expect(calls[0]!.args).not.toContain(STUB_PROMPT);
  });

  it('names an argv overflow in the spawn error instead of surfacing a bare errno', async () => {
    const cap = createCapturingBus();
    const overflow = Object.assign(new Error('spawn ENAMETOOLONG'), { code: 'ENAMETOOLONG' });
    const provider = createInteractiveProvider(spec(), {
      eventBus: cap.bus,
      spawn: () => {
        throw overflow;
      },
      readFile: stubReadFile,
    });

    const r = await provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('past the 32767-byte Windows limit');
    expect(r.error.message).toContain(String(PROMPT_FILE));
  });

  it('reports a spawn failure that arrives as an async error event, not as exit code -1', async () => {
    const cap = createCapturingBus();
    const { spawn, emitError } = makeSpawn();
    const provider = createInteractiveProvider(spec(), { eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    emitError(Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' }));
    const r = await runPromise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('storage-error');
    expect(r.error.message).toContain('failed to spawn');
    expect(r.error.message).toContain('past the 32767-byte Windows limit');
  });

  it('publishes a start and an exit log naming the provider', async () => {
    const cap = createCapturingBus();
    const { spawn, emitExit } = makeSpawn();
    const provider = createInteractiveProvider(spec(), { eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    emitExit(0);
    await runPromise;

    const messages = cap.logs.map((e) => e.message);
    expect(messages).toContain(`interactive-stub: starting session (cwd=${String(CWD)})`);
    expect(messages).toContain('interactive-stub: session exited (code=0)');
  });
});
