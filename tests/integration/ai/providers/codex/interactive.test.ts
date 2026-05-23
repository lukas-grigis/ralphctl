import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import {
  createInteractiveCodexProvider,
  type InteractiveSpawn,
} from '@src/integration/ai/providers/codex/interactive.ts';

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

const PROMPT_FILE = absolutePath('/tmp/codex-prompt.md');
const OUTPUT_FILE = absolutePath('/tmp/codex-output.md');
const CWD = absolutePath('/tmp/codex-interactive-cwd');

describe('createInteractiveCodexProvider', () => {
  it('rejects an unknown model with InvalidStateError', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeSpawn();
    const provider = createInteractiveCodexProvider({ eventBus: cap.bus, spawn });
    const r = await provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: 'gpt-4.1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'gpt-4.1'");
  });

  it('spawns bash -lc with codex --cd <cwd> --model <m> -s workspace-write -a never "$(cat <promptFile>)"', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveCodexProvider({ eventBus: cap.bus, spawn });

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
    expect(calls[0]!.command).toBe('bash');
    expect(calls[0]!.args[0]).toBe('-lc');
    const inner = calls[0]!.args[1];
    expect(inner).toContain('codex');
    expect(inner).toContain(`--cd '${String(CWD)}'`);
    expect(inner).toContain(`--model '${CODEX_MODELS[0]!}'`);
    expect(inner).toContain('-s workspace-write');
    expect(inner).toContain('-a never');
    expect(inner).toContain(`"$(cat '${String(PROMPT_FILE)}')"`);
    expect(calls[0]!.cwd).toBe(String(CWD));
  });

  it('emits --add-dir for cwd, every additionalRoot, and the prompt / output dirs (deduped)', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveCodexProvider({ eventBus: cap.bus, spawn });

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

    const inner = calls[0]!.args[1]!;
    expect(inner).toContain(`--add-dir '${String(CWD)}'`);
    expect(inner).toContain(`--add-dir '${String(repoA)}'`);
    expect(inner).toContain(`--add-dir '${String(repoB)}'`);
    // dirname(promptFile) === dirname(outputFile) === '/tmp' here — dedupe collapses them
    // to a single `--add-dir '/tmp'`. Asserting the count keeps the dedupe load-bearing.
    const addDirOccurrences = inner.match(/--add-dir/g) ?? [];
    expect(addDirOccurrences).toHaveLength(4);
  });

  it('returns InvalidStateError when the session exits non-zero', async () => {
    const cap = createCapturingBus();
    const { spawn, emitExit } = makeSpawn();
    const provider = createInteractiveCodexProvider({ eventBus: cap.bus, spawn });

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
});
