import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { rootSessionId } from '@src/application/session/session.ts';

export interface SignalsSessionOpts {
  readonly prompt: Prompt;
  readonly cwd: AbsolutePath;
  readonly model: string;
  readonly permissions: SessionPermissions;
  readonly signalsFile: AbsolutePath;
  /** Dir the AI writes `signals.json` (and sidecar bodies) into — adapters mount it writable. */
  readonly outputDir: AbsolutePath;
  readonly additionalRoots?: readonly AbsolutePath[] | undefined;
  readonly bodyFile?: AbsolutePath | undefined;
  readonly effort?: string | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  readonly role?: 'generator' | 'evaluator' | undefined;
  readonly resume?: SessionId | undefined;
  /** The full prompt behind a resumed slim continuation; dropped when `resume` is absent. */
  readonly coldPrompt?: Prompt | undefined;
}

/**
 * The `AiSession` for one signals-contract spawn. Call inside the leaf's `execute` scope:
 * `chainSessionId` is the ROOT runner id (the key the TUI's token-usage map is read by — a
 * parallel branch runner shadows the current id), passed as data because integration cannot
 * import the session helper. Absent outside any session scope.
 */
export const signalsSession = (opts: SignalsSessionOpts): AiSession => {
  const chainSessionId = rootSessionId();
  return {
    prompt: opts.prompt,
    cwd: opts.cwd,
    model: opts.model,
    permissions: opts.permissions,
    signalsFile: opts.signalsFile,
    outputDir: opts.outputDir,
    ...(opts.additionalRoots !== undefined ? { additionalRoots: opts.additionalRoots } : {}),
    ...(opts.role !== undefined ? { role: opts.role } : {}),
    ...(chainSessionId !== undefined ? { chainSessionId } : {}),
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    ...(opts.resume !== undefined && opts.coldPrompt !== undefined ? { coldPrompt: opts.coldPrompt } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.bodyFile !== undefined ? { bodyFile: opts.bodyFile } : {}),
  };
};
