import { describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { makeInteractiveSpawn } from '@tests/fixtures/interactive-spawn-fake.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { createInteractiveCodexProvider } from '@src/integration/ai/providers/codex/interactive.ts';

// The session skeleton this adapter delegates to — model validation, prompt-file reads, spawn
// failures, abort precedence, the exit-code branch — is covered once in
// tests/integration/ai/providers/_engine/run-interactive-session.test.ts. What stays here is the
// part that is genuinely Codex-specific: the argv it builds.

const STUB_PROMPT = 'Refine this Codex task.';
const stubReadFile = (): Promise<string> => Promise.resolve(STUB_PROMPT);

const PROMPT_FILE = absolutePath('/tmp/codex-prompt.md');
const OUTPUT_FILE = absolutePath('/tmp/codex-output.md');
const CWD = absolutePath('/tmp/codex-interactive-cwd');

describe('createInteractiveCodexProvider', () => {
  it('rejects a model outside the Codex catalog with InvalidStateError', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeInteractiveSpawn();
    const provider = createInteractiveCodexProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });
    const r = await provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: 'gpt-4.1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'gpt-4.1'");
    expect(r.error.message).toContain('Codex model');
  });

  it('spawns codex directly (no bash wrapper) with --cd, --add-dir, -s, -a, and a prompt-file pointer', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
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
    // Trailing positional is a pointer at the prompt file, never the body — see prompt-pointer.ts.
    expect(args.at(-1)).toContain(String(PROMPT_FILE));
    expect(args).not.toContain(STUB_PROMPT);
    // No bash remnants.
    expect(args).not.toContain('-lc');
    expect(calls[0]!.cwd).toBe(String(CWD));
  });

  it('forwards the resolved effort as -c model_reasoning_effort=<level>, and omits it when unset', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveCodexProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const withEffort = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CODEX_MODELS[0]!,
      effort: 'xhigh',
    });
    emitExit(0);
    await withEffort;

    const args = calls[0]!.args;
    const cIndex = args.indexOf('-c');
    expect(cIndex).toBeGreaterThanOrEqual(0);
    expect(args[cIndex + 1]).toBe('model_reasoning_effort=xhigh');

    const withoutEffort = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CODEX_MODELS[0]!,
    });
    emitExit(0);
    await withoutEffort;
    expect(calls[1]!.args).not.toContain('-c');
  });

  it('emits --add-dir for cwd, every additionalRoot, and the prompt / output dirs (deduped)', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
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

  it('leaves sessionId unset — codex accepts no harness-supplied id at launch', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
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
    if (!result.ok) return;
    expect(result.value.sessionId).toBeUndefined();
    expect(calls[0]!.args).not.toContain('--session-id');
  });
});
