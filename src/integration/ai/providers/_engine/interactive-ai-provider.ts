import type { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Interactive AI-session port. Used by chains where the user converses with the AI directly
 * (refine, plan-interactive). The session takes over the user's terminal — whatever the AI
 * prints goes to the screen, whatever the user types goes to the AI.
 *
 * Because the harness has no read-side on stdout while the user owns the terminal, the AI
 * emits its final answer by writing to {@link InteractiveAiProviderInput.outputFile}. The
 * caller reads that file separately after `run` resolves.
 *
 * The prompt is delivered as a file path ({@link InteractiveAiProviderInput.promptFile}) — the
 * caller writes the rendered prompt to disk first, then the AI is told to read it. This
 * mirrors how interactive coding-assistant CLIs prefer file inputs over giant CLI args.
 *
 * Result semantics:
 *  - `Result.ok({ sessionId? })` — AI exited cleanly. Caller reads `outputFile`. The
 *    `sessionId` field is best-effort: stdio-inherit children don't expose stdout to the
 *    parent, so capture requires PTY mirroring and is not implemented today. Adapters MAY
 *    fill it from out-of-band sources (a logfile the CLI writes) when they have one.
 *  - `Result.error(InvalidStateError)` — AI exited non-zero (user cancelled, error inside
 *     the session, etc.). Caller does not touch `outputFile`.
 *  - `Result.error(StorageError)` — spawn-level failure (binary missing, permission denied).
 */
export interface InteractiveAiProviderInput {
  /** Working directory for the AI. Typically the repo root so the AI can navigate code. */
  readonly cwd: AbsolutePath;
  /**
   * Extra directory roots the AI should be allowed to read alongside `cwd`. Used by flows
   * with multi-repo projects (plan, refine) so the AI can navigate every repo on the project
   * without per-file approval prompts. Adapters MUST surface `InvalidStateError` rather than
   * silently dropping the extras when their CLI cannot mount multiple roots.
   */
  readonly additionalRoots?: readonly AbsolutePath[];
  /** Path to the rendered prompt file the AI is told to read. */
  readonly promptFile: AbsolutePath;
  /** Path the AI is told to write its final output to. The caller reads this after `run` resolves. */
  readonly outputFile: AbsolutePath;
  /** Configured model identifier. */
  readonly model: string;
  /**
   * Effort / reasoning level resolved via `resolveEffort(flowId, settings)`. Provider-native
   * vocabulary; adapters that don't expose a reasoning flag silently ignore the field. Sibling
   * of `AiSession.effort` on the headless port.
   */
  readonly effort?: string;
}

export interface InteractiveAiProviderOutput {
  /**
   * Best-effort session id. Claude and Copilot accept a harness-supplied `--session-id <uuid>`
   * flag at launch; their adapters pre-generate the id, pass it in, and return it on success
   * (mirrored to `session-id.txt` next to `outputFile`, matching the headless contract). Codex's
   * interactive command has no equivalent launch-time override, so its adapter leaves the field
   * unset. Subscribers MUST treat absence as non-fatal — fall back to the runner's session id
   * (from `AsyncLocalStorage`) when correlation is needed.
   */
  readonly sessionId?: string;
}

export interface InteractiveAiProvider {
  /** Hand the terminal to the AI. Resolves when the AI process exits. */
  run(input: InteractiveAiProviderInput): Promise<Result<InteractiveAiProviderOutput, DomainError>>;
}
