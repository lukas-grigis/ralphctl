import { describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { makeInteractiveSpawn } from '@tests/fixtures/interactive-spawn-fake.ts';
import { GROK_MODELS } from '@src/domain/value/settings-models/grok.ts';
import { createInteractiveGrokProvider } from '@src/integration/ai/providers/grok/interactive.ts';

const STUB_PROMPT = 'Refine this Grok task.';
const stubReadFile = (): Promise<string> => Promise.resolve(STUB_PROMPT);

const PROMPT_FILE = absolutePath('/tmp/grok-prompt.md');
const OUTPUT_FILE = absolutePath('/tmp/grok-output.md');
const CWD = absolutePath('/tmp/grok-interactive-cwd');

describe('createInteractiveGrokProvider', () => {
  it('rejects a model outside the Grok catalog with InvalidStateError', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeInteractiveSpawn();
    const provider = createInteractiveGrokProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });
    const r = await provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: 'gpt-5.5' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'gpt-5.5'");
    expect(r.error.message).toContain('Grok model');
  });

  it('spawns grok with a prompt pointer, no --prompt-file, and --permission-mode acceptEdits', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveGrokProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: GROK_MODELS[0]!,
    });
    emitExit(0);
    expect((await runPromise).ok).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('grok');
    const args = calls[0]!.args;
    expect(args).toContain('--no-auto-update');
    expect(args).toContain('--cwd');
    expect(args).toContain(String(CWD));
    expect(args).toContain('-m');
    expect(args).toContain(GROK_MODELS[0]!);
    expect(args).toContain('--permission-mode');
    expect(args).toContain('acceptEdits');
    const sandboxIdx = args.indexOf('--sandbox');
    expect(sandboxIdx).toBeGreaterThanOrEqual(0);
    expect(args[sandboxIdx + 1]).toBe('off');
    expect(args).not.toContain('--always-approve');
    // No `--leader-socket`: Grok's default `~/.grok/leader.sock` is the configuration that
    // demonstrably starts. Forcing a per-session socket makes Grok stand up a fresh leader and
    // was the one flag present in every hung session and absent from every healthy one.
    expect(args).not.toContain('--leader-socket');
    expect(args).not.toContain('--prompt-file');
    expect(args).not.toContain('-r');
    expect(args).not.toContain('-p');
    // The pointer names the caller's real prompt file — the body never rides argv.
    expect(args.at(-1)).toContain(String(PROMPT_FILE));
    expect(args).not.toContain(STUB_PROMPT);
    expect(calls[0]!.cwd).toBe(String(CWD));
  });

  it('writes a per-session debug log beside outputFile, so a hung session leaves an account', async () => {
    // `stdio: 'inherit'` means the harness can observe nothing about the child. When an interactive
    // session hangs, Grok's own debug log is the only record of which startup phase it stopped in.
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveGrokProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: GROK_MODELS[0]!,
    });
    emitExit(0);
    await runPromise;

    const args = calls[0]!.args;
    const idx = args.indexOf('--debug-file');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/tmp/grok-debug.log');
    // `--debug` is deliberately NOT passed — it also changes what Grok puts on screen.
    expect(args).not.toContain('--debug');
  });

  it('forwards the resolved effort as --effort <level>, and omits it when unset', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveGrokProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const withEffort = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: GROK_MODELS[0]!,
      effort: 'xhigh',
    });
    emitExit(0);
    await withEffort;

    const args = calls[0]!.args;
    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('xhigh');

    const withoutEffort = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: GROK_MODELS[0]!,
    });
    emitExit(0);
    await withoutEffort;
    expect(calls[1]!.args).not.toContain('--effort');
  });

  it('passes a pre-generated session id via -s <uuid>', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveGrokProvider({
      eventBus: cap.bus,
      spawn,
      readFile: stubReadFile,
      newSessionId: () => 'fixed-session-id',
    });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: GROK_MODELS[0]!,
    });
    emitExit(0);
    await runPromise;

    const args = calls[0]!.args;
    const idx = args.indexOf('-s');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('fixed-session-id');
  });
});
