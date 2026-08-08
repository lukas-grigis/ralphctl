import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { makeInteractiveSpawn } from '@tests/fixtures/interactive-spawn-fake.ts';
import { OPENCODE_MODELS } from '@src/domain/value/settings-models/opencode.ts';
import { createInteractiveOpencodeProvider } from '@src/integration/ai/providers/opencode/interactive.ts';

// The session skeleton this adapter delegates to — model validation, prompt-file reads, spawn
// failures, abort precedence, the exit-code branch — is covered once in
// tests/integration/ai/providers/_engine/run-interactive-session.test.ts. What stays here is the
// part that is genuinely OpenCode-specific: the argv it builds.

const STUB_PROMPT = 'Refine this OpenCode task.';
const stubReadFile = (): Promise<string> => Promise.resolve(STUB_PROMPT);

const PROMPT_FILE = absolutePath('/tmp/opencode-prompt.md');
const OUTPUT_FILE = absolutePath('/tmp/opencode-output.md');
const CWD = absolutePath('/tmp/opencode-interactive-cwd');
const MODEL = OPENCODE_MODELS[0]!;

describe('createInteractiveOpencodeProvider', () => {
  it('spawns opencode with the project directory positional first, then --model and --prompt', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveOpencodeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    emitExit(0);
    const result = await runPromise;
    expect(result.ok).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('opencode');
    // Order is load-bearing: `opencode [project]` takes the directory positionally, and the
    // rendered prompt (which carries the audit-[09] contract section) rides --prompt — as a
    // pointer at the prompt file, never the body.
    expect(calls[0]!.args.slice(0, 4)).toEqual([String(CWD), '--model', MODEL, '--prompt']);
    expect(calls[0]!.args.at(-1)).toContain(String(PROMPT_FILE));
    expect(calls[0]!.args).not.toContain(STUB_PROMPT);
    expect(calls[0]!.cwd).toBe(String(CWD));
  });

  it('grants read access to the prompt directory only, since OpenCode has no --add-dir', async () => {
    // Without this the CLI auto-rejects the pointer target as `permission requested:
    // external_directory` and the session opens with no instructions — PROMPT_FILE lives outside
    // CWD for ideate and memory-distill. The grant is scoped: everything else stays denied.
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveOpencodeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    emitExit(0);
    await runPromise;

    const config = JSON.parse(calls[0]!.env!['OPENCODE_CONFIG_CONTENT']!) as {
      permission: { external_directory: Record<string, string> };
    };
    const rules = config.permission.external_directory;
    expect(rules['*']).toBe('deny');
    expect(rules[join(dirname(String(PROMPT_FILE)), '*')]).toBe('allow');
    // Every allowed key names the prompt directory (in one separator spelling or the other, since
    // a backslash glob may not match a path OpenCode normalised) — nothing wider slips in.
    const promptDir = dirname(String(PROMPT_FILE)).replaceAll('\\', '/');
    for (const [pattern, action] of Object.entries(rules)) {
      if (action === 'allow') expect(pattern.replaceAll('\\', '/')).toBe(`${promptDir}/*`);
    }
  });

  it('drops effort — --variant is `run`-only and the yargs-strict TUI command would exit 1', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
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
    const { spawn } = makeInteractiveSpawn();
    const provider = createInteractiveOpencodeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const r = await provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: 'gpt-5.5' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'gpt-5.5'");
  });

  it('leaves sessionId unset — opencode mints its own and only surfaces it on the run stream', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
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
