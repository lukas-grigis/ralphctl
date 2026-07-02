import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { currentSessionId } from '@src/application/session/session.ts';

export interface ReadOnlySignalsSessionOpts {
  /** Working directory the AI session opens in — the repository (or repo-derived) path. */
  readonly cwd: AbsolutePath;
  readonly prompt: Prompt;
  readonly model: string;
  readonly signalsFile: AbsolutePath;
  /** Per-run forensic dir the AI writes `signals.json` into directly (audit-[09]). */
  readonly outputDir: AbsolutePath;
  /** Raw AI response capture — provider-dependent (Claude implements it today). */
  readonly bodyFile?: AbsolutePath;
  readonly effort?: string;
  /** Chain abort signal — threaded so a TUI cancel mid-spawn kills the child. */
  readonly abortSignal?: AbortSignal;
}

/**
 * Shared per-call `AiSession` profile for every read-only, one-shot AI flow — `readiness`,
 * `detect-scripts`, `detect-skills` — audit-[09] aware: the AI's permission profile stays
 * READ_ONLY for repository navigation, augmented with the Write tool so it can write
 * `signals.json` (and any sidecar bodies) into `outputDir`.
 *
 * Call only within a `runWithSession` scope: `chainSessionId` is captured from the ambient
 * session at call time (omitted when invoked outside one, e.g. a bare test).
 */
export const readOnlySignalsSession = (opts: ReadOnlySignalsSessionOpts): AiSession => {
  // `currentSessionId()` is read inside the leaf's execute scope (the runner wraps it in
  // `runWithSession`) and threaded onto the session as DATA so the headless adapter can key
  // the token-usage event by the runner id without importing the application session helper
  // across the layer boundary. Undefined out of session scope → the spread omits it.
  const chainSessionId = currentSessionId();
  return {
    prompt: opts.prompt,
    cwd: opts.cwd,
    model: opts.model,
    permissions: READ_ONLY,
    signalsFile: opts.signalsFile,
    outputDir: opts.outputDir,
    ...(chainSessionId !== undefined ? { chainSessionId } : {}),
    ...(opts.bodyFile !== undefined ? { bodyFile: opts.bodyFile } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    // Thread the chain's abort signal so a TUI cancel mid-spawn kills the child.
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  };
};
