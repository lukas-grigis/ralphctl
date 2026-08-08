import { describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { makeInteractiveSpawn } from '@tests/fixtures/interactive-spawn-fake.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { createInteractiveClaudeProvider } from '@src/integration/ai/providers/claude/interactive.ts';

// The session skeleton this adapter delegates to — model validation, prompt-file reads, spawn
// failures, abort precedence, the exit-code branch, the session-id sidechannel — is covered once
// in tests/integration/ai/providers/_engine/run-interactive-session.test.ts. What stays here is
// the part that is genuinely Claude-specific: the argv it builds.

const STUB_PROMPT = 'You are helping refine a ticket. Do X.';
const stubReadFile = (): Promise<string> => Promise.resolve(STUB_PROMPT);

const PROMPT_FILE = absolutePath('/tmp/claude-prompt.md');
const OUTPUT_FILE = absolutePath('/tmp/claude-output.md');
const CWD = absolutePath('/tmp/claude-interactive-cwd');

describe('createInteractiveClaudeProvider', () => {
  it('rejects a model outside the Claude catalog with InvalidStateError', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeInteractiveSpawn();
    const provider = createInteractiveClaudeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });
    const r = await provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: 'gpt-5',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.message).toContain("'gpt-5'");
    expect(r.error.message).toContain('Claude model');
  });

  it('spawns claude directly (no bash wrapper) and passes a prompt-file pointer as positional arg', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveClaudeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CLAUDE_MODELS[0]!,
    });
    emitExit(0);
    const result = await runPromise;
    expect(result.ok).toBe(true);

    expect(calls).toHaveLength(1);
    // No bash wrapper — command is claude directly.
    expect(calls[0]!.command).toBe('claude');
    const args = calls[0]!.args;
    expect(args).toContain('--model');
    expect(args).toContain(CLAUDE_MODELS[0]!);
    expect(args).toContain('--permission-mode');
    expect(args).toContain('acceptEdits');
    // The trailing positional is claude's opening message: a pointer at the prompt file, never
    // the body — inlining it capped every session at the platform command-line limit.
    expect(args.at(-1)).toContain(String(PROMPT_FILE));
    expect(args).not.toContain(STUB_PROMPT);
    // No -lc / bash remnants.
    expect(args).not.toContain('-lc');
    expect(args).not.toContain('bash');
    expect(calls[0]!.cwd).toBe(String(CWD));
  });

  it('forwards the resolved effort as --effort <level>, and omits the flag when unset', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveClaudeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const withEffort = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CLAUDE_MODELS[0]!,
      effort: 'high',
    });
    emitExit(0);
    await withEffort;

    const args = calls[0]!.args;
    const effortIndex = args.indexOf('--effort');
    expect(effortIndex).toBeGreaterThanOrEqual(0);
    expect(args[effortIndex + 1]).toBe('high');

    const withoutEffort = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CLAUDE_MODELS[0]!,
    });
    emitExit(0);
    await withoutEffort;
    expect(calls[1]!.args).not.toContain('--effort');
  });

  it('auto-mounts dirname(outputFile) and dirname(promptFile) so framework-controlled writes never prompt', async () => {
    // The output file lives under `~/.ralphctl/data/sprints/…` (outside the project cwd) and
    // `acceptEdits` only auto-approves writes inside `--add-dir` roots, so without mounting the
    // prompt / output dirs the user is hit by "Create file?" prompts mid-refine.
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveClaudeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const sprintRefinementDir = '/Users/x/.ralphctl/data/sprints/abc/refinement/foo';
    const runPromise = provider.run({
      cwd: CWD,
      promptFile: absolutePath(`${sprintRefinementDir}/prompt.md`),
      outputFile: absolutePath(`${sprintRefinementDir}/requirements.md`),
      model: CLAUDE_MODELS[0]!,
    });
    emitExit(0);
    const result = await runPromise;
    expect(result.ok).toBe(true);

    const args = calls[0]!.args;
    // Flat argv: --add-dir followed by the path value.
    expect(args).toContain('--add-dir');
    expect(args).toContain(String(CWD));
    expect(args).toContain(sprintRefinementDir);
    // Prompt and output share a dir → emitted exactly once (deduped).
    const occurrences = args.filter((a) => a === sprintRefinementDir);
    expect(occurrences).toHaveLength(1);
  });

  it('keeps caller-supplied additionalRoots and folds duplicates with the auto-mounted dirs', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveClaudeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const extraRepo = absolutePath('/Users/x/repos/sibling-repo');
    const runPromise = provider.run({
      cwd: CWD,
      additionalRoots: [extraRepo, CWD], // CWD duplicate is folded out
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CLAUDE_MODELS[0]!,
    });
    emitExit(0);
    await runPromise;

    const args = calls[0]!.args;
    expect(args).toContain(String(CWD));
    expect(args).toContain(String(extraRepo));
    // dirname of /tmp/claude-prompt.md and /tmp/claude-output.md is /tmp
    expect(args).toContain('/tmp');
    // CWD must appear once even though additionalRoots also lists it.
    const cwdHits = args.filter((a) => a === String(CWD));
    expect(cwdHits).toHaveLength(1);
  });

  it('passes a pre-generated session id via --session-id <uuid>', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeInteractiveSpawn();
    const provider = createInteractiveClaudeProvider({
      eventBus: cap.bus,
      spawn,
      readFile: stubReadFile,
      newSessionId: () => 'fixed-session-id',
    });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CLAUDE_MODELS[0]!,
    });
    emitExit(0);
    await runPromise;

    const args = calls[0]!.args;
    const sidIndex = args.indexOf('--session-id');
    expect(sidIndex).toBeGreaterThanOrEqual(0);
    expect(args[sidIndex + 1]).toBe('fixed-session-id');
  });
});
