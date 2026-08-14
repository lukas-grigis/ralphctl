import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { type InteractiveSpawnCall, makeInteractiveSpawn } from '@tests/fixtures/interactive-spawn-fake.ts';
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

/** The `external_directory` rule map the adapter injected via `OPENCODE_CONFIG_CONTENT`. */
const grantedRules = (call: InteractiveSpawnCall): Record<string, string> => {
  const config = JSON.parse(call.env!['OPENCODE_CONFIG_CONTENT']!) as {
    permission: { external_directory: Record<string, string> };
  };
  return config.permission.external_directory;
};

/**
 * The directories those rules actually grant. Each root yields up to four keys (both separator
 * spellings × `*` and `**`, which collapse to two on POSIX), so strip the pattern tail to compare
 * against what the engine folded.
 */
const grantedRoots = (call: InteractiveSpawnCall): ReadonlySet<string> =>
  new Set(
    Object.entries(grantedRules(call))
      .filter(([, action]) => action === 'allow')
      .map(([pattern]) => pattern.replace(/[/\\]\*{1,2}$/, ''))
  );

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

  it('grants the prompt directory, since OpenCode has no --add-dir', async () => {
    // Without this the CLI auto-rejects the pointer target as `permission requested:
    // external_directory` and the session opens with no instructions — PROMPT_FILE lives outside
    // CWD for ideate and memory-distill. The grant is still scoped: `*` stays denied.
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveOpencodeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({ cwd: CWD, promptFile: PROMPT_FILE, outputFile: OUTPUT_FILE, model: MODEL });
    emitExit(0);
    await runPromise;

    const rules = grantedRules(calls[0]!);
    expect(rules['*']).toBe('deny');
    expect(rules[join(dirname(String(PROMPT_FILE)), '*')]).toBe('allow');
    // Nested reads too: a root is a repository, and the pointer-era `*`-only grant reached a file
    // sitting directly in the directory and nothing below it.
    expect(rules[join(dirname(String(PROMPT_FILE)), '**')]).toBe('allow');
    // Nothing wider than the roots the engine folded slips in.
    expect(grantedRoots(calls[0]!)).toEqual(new Set([String(CWD), dirname(String(PROMPT_FILE))]));
  });

  it('grants every additionalRoot — #278: they used to be dropped without a word', async () => {
    // The port contract says an adapter that cannot mount a root MUST surface InvalidStateError
    // rather than quietly using less. This adapter silently ignored `additionalRoots` because its
    // env hook only ever saw `input`, never the engine's folded root list — so plan / refine on a
    // multi-repo project opened a session that could not read the sibling repositories at all.
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveOpencodeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const sibling = absolutePath('/tmp/opencode-sibling-repo');
    const runPromise = provider.run({
      cwd: CWD,
      additionalRoots: [sibling],
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: MODEL,
    });
    emitExit(0);
    await runPromise;

    expect(grantedRoots(calls[0]!)).toEqual(new Set([String(CWD), String(sibling), dirname(String(PROMPT_FILE))]));
    expect(grantedRules(calls[0]!)['*']).toBe('deny');
  });

  it('refuses a root it cannot express as a glob key, loudly and without spawning', async () => {
    // A grant key that fails to match does NOT error in OpenCode — it opens a session that cannot
    // read the root, which is #278 all over again with extra steps. The only honest answer for a
    // path carrying glob syntax is the port's documented InvalidStateError.
    const cap = createCapturingBus();
    const { spawn, calls } = makeInteractiveSpawn();
    const provider = createInteractiveOpencodeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const unexpressible = absolutePath('/tmp/opencode-repo-[v2]');
    const r = await provider.run({
      cwd: CWD,
      additionalRoots: [unexpressible],
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: MODEL,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain(String(unexpressible));
    expect(calls).toHaveLength(0);
    // No "starting session" line either — the refusal happens before the child would have launched.
    expect(cap.logs.map((e) => e.message).filter((m) => m.includes('starting session'))).toEqual([]);
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
