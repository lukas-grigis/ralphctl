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

const PROMPT_FILE = absolutePath('/tmp/claude-prompt.md');
const OUTPUT_FILE = absolutePath('/tmp/claude-output.md');
const CWD = absolutePath('/tmp/claude-interactive-cwd');

describe('createInteractiveClaudeProvider', () => {
  it('rejects an unknown model with InvalidStateError', async () => {
    const cap = createCapturingBus();
    const { spawn } = makeSpawn();
    const provider = createInteractiveClaudeProvider({ eventBus: cap.bus, spawn });
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

  it('auto-mounts dirname(outputFile) and dirname(promptFile) so framework-controlled writes never prompt', async () => {
    // This is the bug fix: the user was hit by "Create file?" prompts inside refine because
    // the output file lives under `~/.ralphctl/data/sprints/…` (outside the project cwd)
    // and `acceptEdits` only auto-approves writes inside `--add-dir` roots. The adapter
    // now mounts the prompt/output dirs unconditionally.
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveClaudeProvider({ eventBus: cap.bus, spawn });

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
    expect(calls[0]!.command).toBe('bash');
    expect(calls[0]!.args[0]).toBe('-lc');
    const inner = calls[0]!.args[1] ?? '';
    expect(inner).toContain(`--add-dir '${String(CWD)}'`);
    expect(inner).toContain(`--add-dir '${sprintRefinementDir}'`);
    expect(inner).toContain('--permission-mode acceptEdits');
    // Prompt and output share a dir → emitted exactly once (deduped).
    const occurrences = inner.match(/--add-dir '\/Users\/x\/\.ralphctl\/data\/sprints\/abc\/refinement\/foo'/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('keeps caller-supplied additionalRoots and folds duplicates with the auto-mounted dirs', async () => {
    const cap = createCapturingBus();
    const { spawn, calls, emitExit } = makeSpawn();
    const provider = createInteractiveClaudeProvider({ eventBus: cap.bus, spawn });

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

    const inner = calls[0]!.args[1] ?? '';
    expect(inner).toContain(`--add-dir '${String(CWD)}'`);
    expect(inner).toContain(`--add-dir '${String(extraRepo)}'`);
    expect(inner).toContain(`--add-dir '/tmp'`); // dirname of prompt and output
    // CWD must appear once even though additionalRoots also lists it.
    const cwdHits = inner.match(/--add-dir '\/tmp\/claude-interactive-cwd'/g) ?? [];
    expect(cwdHits).toHaveLength(1);
  });

  it('returns InvalidStateError when the session exits non-zero', async () => {
    const cap = createCapturingBus();
    const { spawn, emitExit } = makeSpawn();
    const provider = createInteractiveClaudeProvider({ eventBus: cap.bus, spawn });

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
});
