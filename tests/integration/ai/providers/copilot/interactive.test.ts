import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';
import { createInteractiveCopilotProvider } from '@src/integration/ai/providers/copilot/interactive.ts';
import type { InteractiveSpawn } from '@src/integration/ai/providers/_engine/interactive-spawn.ts';

// The session skeleton this adapter delegates to — model validation, prompt-file reads, spawn
// failures, abort precedence, the exit-code branch, the session-id sidechannel — is covered once
// in tests/integration/ai/providers/_engine/run-interactive-session.test.ts. What stays here is
// the part that is genuinely Copilot-specific: the argv it builds.

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

const PROMPT_FILE = absolutePath('/tmp/copilot-prompt.md');
const OUTPUT_FILE = absolutePath('/tmp/copilot-output.md');
const CWD = absolutePath('/tmp/copilot-interactive-cwd');
const PROMPT_CONTENT = '# Test prompt\n\nDo a thing.';
const stubReadFile = (): Promise<string> => Promise.resolve(PROMPT_CONTENT);

describe('createInteractiveCopilotProvider', () => {
  it('rejects a model outside the Copilot catalog with InvalidStateError', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeSpawn();
    const provider = createInteractiveCopilotProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });
    const r = await provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: 'claude-haiku-4-5',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'claude-haiku-4-5'");
    expect(r.error.message).toContain('Copilot model');
  });

  it('spawns copilot directly with --add-dir=<path>, --model=<model>, --allow-all-tools, and -i <prompt pointer>', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveCopilotProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: COPILOT_MODELS[0]!,
    });
    emitExit(0);
    const result = await runPromise;
    expect(result.ok).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('copilot');
    const args = calls[0]!.args;
    // `--add-dir` and `--model` are equals-only per the Copilot CLI reference; passing them
    // space-separated leaves the parser without a bound value and silently drops the `-i`
    // seed (TUI starts at an empty input box).
    expect(args).toContain(`--add-dir=${String(CWD)}`);
    // Adapter auto-mounts the output-file and prompt-file dirs so the harness's writes
    // don't trigger a per-file approval prompt mid-session.
    expect(args).toContain('--add-dir=/tmp');
    expect(args).toContain(`--model=${COPILOT_MODELS[0]!}`);
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('--model');
    expect(args).toContain('--allow-all-tools');
    expect(args).not.toContain('--deny-tool=write');
    expect(args).not.toContain('--allow-tool=write');
    // A pointer at the prompt file rides `-i` as a single argv element (no bash, no command
    // substitution — matches v1's working adapter and avoids shell-quoting failure modes). The
    // body stays on disk so argv size does not track prompt size.
    const iIndex = args.indexOf('-i');
    expect(iIndex).toBeGreaterThanOrEqual(0);
    expect(args[iIndex + 1]).toContain(String(PROMPT_FILE));
    expect(args).not.toContain(PROMPT_CONTENT);
    expect(calls[0]!.cwd).toBe(String(CWD));
  });

  it('forwards the resolved effort as --effort=<level>, and omits the flag when unset', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveCopilotProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const withEffort = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: COPILOT_MODELS[0]!,
      effort: 'high',
    });
    emitExit(0);
    await withEffort;
    expect(calls[0]!.args).toContain('--effort=high');

    const withoutEffort = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: COPILOT_MODELS[0]!,
    });
    emitExit(0);
    await withoutEffort;
    expect(calls[1]!.args.some((a) => a.startsWith('--effort'))).toBe(false);
  });

  it('auto-mounts dirname(outputFile) and dirname(promptFile) for harness-controlled writes', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveCopilotProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: absolutePath('/Users/x/.ralphctl/data/sprints/abc/refinement/foo/prompt.md'),
      outputFile: absolutePath('/Users/x/.ralphctl/data/sprints/abc/refinement/foo/requirements.md'),
      model: COPILOT_MODELS[0]!,
    });
    emitExit(0);
    await runPromise;

    const args = calls[0]!.args;
    const sharedDirFlag = '--add-dir=/Users/x/.ralphctl/data/sprints/abc/refinement/foo';
    // Both prompt and output share a dir → emitted once (deduped).
    const occurrences = args.filter((a) => a === sharedDirFlag).length;
    expect(occurrences).toBe(1);
  });

  it('passes a pre-generated session id via --session-id=<uuid>', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveCopilotProvider({
      eventBus: cap.bus,
      spawn,
      readFile: stubReadFile,
      newSessionId: () => 'fixed-session-id',
    });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: COPILOT_MODELS[0]!,
    });
    emitExit(0);
    await runPromise;

    expect(calls[0]!.args).toContain('--session-id=fixed-session-id');
  });
});
