import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { createInteractiveCodexProvider } from '@src/integration/ai/providers/codex/interactive.ts';
import type { InteractiveSpawn } from '@src/integration/ai/providers/_engine/interactive-spawn.ts';

interface CapturingSpawnState {
  readonly spawn: InteractiveSpawn;
  readonly calls: ReadonlyArray<{ readonly command: string; readonly args: readonly string[]; readonly cwd: string }>;
  readonly emitExit: (code: number | null) => void;
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
  };
};

const STUB_PROMPT = 'Refine this Codex task.';
const stubReadFile = (): Promise<string> => Promise.resolve(STUB_PROMPT);

const PROMPT_FILE = absolutePath('/tmp/codex-prompt.md');
const OUTPUT_FILE = absolutePath('/tmp/codex-output.md');
const CWD = absolutePath('/tmp/codex-interactive-cwd');

describe('createInteractiveCodexProvider', () => {
  it('rejects an unknown model with InvalidStateError', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeSpawn();
    const provider = createInteractiveCodexProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });
    const r = await provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: 'gpt-4.1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'gpt-4.1'");
  });

  it('returns StorageError when the prompt file cannot be read', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeSpawn();
    const failRead = (): Promise<string> => Promise.reject(new Error('ENOENT'));
    const provider = createInteractiveCodexProvider({ eventBus: cap.bus, spawn, readFile: failRead });

    const r = await provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CODEX_MODELS[0]!,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('storage-error');
    expect(r.error.message).toContain('failed to read prompt file');
  });

  it('spawns codex directly (no bash wrapper) with --cd, --add-dir, -s, -a, and prompt content', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveCodexProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CODEX_MODELS[0]!,
    });
    emitExit(0);
    const result = await runPromise;
    expect(result.ok).toBe(true);

    expect(calls).toHaveLength(1);
    // No bash wrapper — command is codex directly.
    expect(calls[0]!.command).toBe('codex');
    const args = calls[0]!.args;
    expect(args).toContain('--cd');
    expect(args).toContain(String(CWD));
    expect(args).toContain('--model');
    expect(args).toContain(CODEX_MODELS[0]!);
    expect(args).toContain('-s');
    expect(args).toContain('workspace-write');
    expect(args).toContain('-a');
    expect(args).toContain('never');
    expect(args).toContain(STUB_PROMPT);
    // No bash remnants.
    expect(args).not.toContain('-lc');
    expect(calls[0]!.cwd).toBe(String(CWD));
  });

  it('emits --add-dir for cwd, every additionalRoot, and the prompt / output dirs (deduped)', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveCodexProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const repoA = absolutePath('/tmp/codex-repo-a');
    const repoB = absolutePath('/tmp/codex-repo-b');

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CODEX_MODELS[0]!,
      additionalRoots: [repoA, repoB],
    });
    emitExit(0);
    const result = await runPromise;
    expect(result.ok).toBe(true);

    const args = calls[0]!.args;
    expect(args).toContain('--add-dir');
    expect(args).toContain(String(CWD));
    expect(args).toContain(String(repoA));
    expect(args).toContain(String(repoB));
    // dirname(promptFile) === dirname(outputFile) === '/tmp' — dedupe collapses them
    // to a single --add-dir entry. Count via flag occurrences stays load-bearing.
    const addDirCount = args.filter((a) => a === '--add-dir').length;
    expect(addDirCount).toBe(4); // cwd + repoA + repoB + /tmp (deduped prompt/output dir)
  });

  it('returns InvalidStateError when the session exits non-zero', async () => {
    const cap = createCapturingBus();
    const { spawn, emitExit } = makeSpawn();
    const provider = createInteractiveCodexProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CODEX_MODELS[0]!,
    });
    emitExit(2);
    const result = await runPromise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(result.error.message).toContain('exited with code 2');
  });

  it('returns AbortError (not InvalidStateError) when aborted before a non-zero exit', async () => {
    // A TUI cancel fires: attachAbortKill SIGTERMs the stdio-inherit child, which exits non-zero.
    // The adapter must classify this as AbortError (the one error chains propagate transparently),
    // NOT the generic session-exit InvalidStateError a downstream guard could catch and continue.
    const cap = createCapturingBus();
    const { spawn, emitExit } = makeSpawn();
    const provider = createInteractiveCodexProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });
    const controller = new AbortController();

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CODEX_MODELS[0]!,
      abortSignal: controller.signal,
    });
    controller.abort();
    emitExit(130);
    const result = await runPromise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('aborted');
    expect(result.error.name).toBe('AbortError');
  });
});
