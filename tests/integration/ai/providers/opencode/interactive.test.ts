import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { OPENCODE_MODELS } from '@src/domain/value/settings-models/opencode.ts';
import { createInteractiveOpencodeProvider } from '@src/integration/ai/providers/opencode/interactive.ts';
import type { InteractiveSpawn } from '@src/integration/ai/providers/_engine/interactive-spawn.ts';

// The session skeleton this adapter delegates to — model validation, prompt-file reads, spawn
// failures, abort precedence, the exit-code branch — is covered once in
// tests/integration/ai/providers/_engine/run-interactive-session.test.ts. What stays here is the
// part that is genuinely OpenCode-specific: the argv it builds.

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

const STUB_PROMPT = 'Refine this OpenCode task.';
const stubReadFile = (): Promise<string> => Promise.resolve(STUB_PROMPT);

const PROMPT_FILE = absolutePath('/tmp/opencode-prompt.md');
const OUTPUT_FILE = absolutePath('/tmp/opencode-output.md');
const CWD = absolutePath('/tmp/opencode-interactive-cwd');
const MODEL = OPENCODE_MODELS[0]!;

describe('createInteractiveOpencodeProvider', () => {
  it('spawns opencode with the project directory positional first, then --model and --prompt', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveOpencodeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    emitExit(0);
    const result = await runPromise;
    expect(result.ok).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('opencode');
    // Order is load-bearing: `opencode [project]` takes the directory positionally, and the
    // rendered prompt (which carries the audit-[09] contract section) rides --prompt.
    expect(calls[0]!.args).toEqual([String(CWD), '--model', MODEL, '--prompt', STUB_PROMPT]);
    expect(calls[0]!.cwd).toBe(String(CWD));
  });

  it('drops effort — --variant is `run`-only and the yargs-strict TUI command would exit 1', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveOpencodeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: MODEL,
      effort: 'high',
    });
    emitExit(0);
    const result = await runPromise;
    expect(result.ok).toBe(true);

    expect(calls[0]!.args).not.toContain('--variant');
    expect(calls[0]!.args).not.toContain('high');
  });

  it('rejects a bare model id that is missing the provider namespace', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeSpawn();
    const provider = createInteractiveOpencodeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const r = await provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: 'gpt-5.5' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'gpt-5.5'");
  });

  it('leaves sessionId unset — opencode mints its own and only surfaces it on the run stream', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveOpencodeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    emitExit(0);
    const result = await runPromise;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBeUndefined();
    expect(calls[0]!.args).not.toContain('--session-id');
  });
});
