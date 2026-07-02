import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { createInteractiveClaudeProvider } from '@src/integration/ai/providers/claude/interactive.ts';
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

const STUB_PROMPT = 'You are helping refine a ticket. Do X.';
const stubReadFile = (): Promise<string> => Promise.resolve(STUB_PROMPT);

const PROMPT_FILE = absolutePath('/tmp/claude-prompt.md');
const OUTPUT_FILE = absolutePath('/tmp/claude-output.md');
const CWD = absolutePath('/tmp/claude-interactive-cwd');

describe('createInteractiveClaudeProvider', () => {
  it('rejects an unknown model with InvalidStateError', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeSpawn();
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
  });

  it('returns StorageError when the prompt file cannot be read', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeSpawn();
    const failRead = (): Promise<string> => Promise.reject(new Error('ENOENT: no such file'));
    const provider = createInteractiveClaudeProvider({ eventBus: cap.bus, spawn, readFile: failRead });

    const r = await provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CLAUDE_MODELS[0]!,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('storage-error');
    expect(r.error.message).toContain('failed to read prompt file');
  });

  it('spawns claude directly (no bash wrapper) and passes prompt content as positional arg', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
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
    // --permission-mode and prompt content are present as raw argv elements.
    expect(args).toContain('--permission-mode');
    expect(args).toContain('acceptEdits');
    expect(args).toContain(STUB_PROMPT);
    // No -lc / bash remnants.
    expect(args).not.toContain('-lc');
    expect(args).not.toContain('bash');
  });

  it('auto-mounts dirname(outputFile) and dirname(promptFile) so framework-controlled writes never prompt', async () => {
    // This is the bug fix: the user was hit by "Create file?" prompts inside refine because
    // the output file lives under `~/.ralphctl/data/sprints/…` (outside the project cwd)
    // and `acceptEdits` only auto-approves writes inside `--add-dir` roots. The adapter
    // now mounts the prompt/output dirs unconditionally.
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
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

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('claude');
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
    const { spawn, calls, emitExit } = makeSpawn();
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

  it('returns InvalidStateError when the session exits non-zero', async () => {
    const cap = createCapturingBus();
    const { spawn, emitExit } = makeSpawn();
    const provider = createInteractiveClaudeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CLAUDE_MODELS[0]!,
    });
    emitExit(7);
    const result = await runPromise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(result.error.message).toContain('code 7');
  });

  it('returns AbortError (not InvalidStateError) when aborted before a non-zero exit', async () => {
    // A TUI cancel fires: attachAbortKill SIGTERMs the stdio-inherit child, which exits non-zero.
    // The adapter must classify this as AbortError (the one error chains propagate transparently),
    // NOT the generic session-exit InvalidStateError a downstream guard could catch and continue.
    const cap = createCapturingBus();
    const { spawn, emitExit } = makeSpawn();
    const provider = createInteractiveClaudeProvider({ eventBus: cap.bus, spawn, readFile: stubReadFile });
    const controller = new AbortController();

    const runPromise = provider.run({
      cwd: CWD,
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: CLAUDE_MODELS[0]!,
      abortSignal: controller.signal,
    });
    controller.abort();
    emitExit(143);
    const result = await runPromise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('aborted');
    expect(result.error.name).toBe('AbortError');
  });
});
