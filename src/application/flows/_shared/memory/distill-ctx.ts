import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';

/**
 * One provider's distill proposal slot. Filled by the per-provider `distill-propose-<tool>` leaf
 * (the AI's full-file context rewrite), consulted by `distill-confirm-<tool>` (the human gate),
 * and written to disk by `distill-write-<tool>`.
 */
export interface DistillProviderEntry {
  /**
   * Full updated context-file body the AI proposed for this provider — the COMPLETE file, ready
   * to land at {@link targetPath} verbatim. The distill prompt is a full-file write-back (no
   * signals.json), so the AI's whole output IS the proposed content.
   */
  readonly proposedContent?: string;
  /** Absolute path the proposed content lands at — `<repo>/<targetPathFor(tool)>`. */
  readonly targetPath?: AbsolutePath;
  /** Operator's confirm answer. `true` → write; `false` / undefined → no-op. */
  readonly accepted?: boolean;
}

/**
 * Distill-LOCAL context for the self-contained distill sub-chain. The sub-chain
 * runs over THIS ctx — NOT the host close-sprint / review ctx — so composing it into both close
 * paths only widens those ctxs with a single `distillRequested` flag (the distill leaf carries its
 * own ctx internally). The readiness leaf surface stays untouched.
 *
 * Threaded by {@link createDistillLearningsSubChain}:
 *  - `distillRequested` — the opt-in gate the `distill-gate` guard reads. When `false` the whole
 *    body is skipped: no ledger read, no AI session, no file touch.
 *  - `repository` — the repo whose native context files the learnings are folded into (path for
 *    the write target + cwd, name for record context, tooling for the prompt's `PROJECT_TOOLING`).
 *  - `candidates` — the not-yet-promoted learnings loaded once from the project ledger; shared
 *    across every provider's propose leaf (the same curated set folds into each native file).
 *  - `entries` — per-tool proposal / confirm / write state, keyed by {@link AssistantTool}.
 *  - `acceptedIds` — ids the operator confirmed for promotion across all providers; the terminal
 *    stamp leaf flips these `promotedAt` after every write succeeds.
 *
 * @public
 */
export interface DistillLearningsCtx {
  /** Opt-in gate. `true` → run the distill body; `false` → the guard skips it entirely. */
  readonly distillRequested: boolean;
  /** The repository whose context files receive the distilled learnings. */
  readonly repository: Repository;
  /** Loaded, de-duped, not-yet-promoted candidate learnings (filled by `load-learnings`). */
  readonly candidates?: readonly LearningRecord[];
  /** Per-tool propose / confirm / write state. */
  readonly entries: Partial<Record<AssistantTool, DistillProviderEntry>>;
  /** Record ids the operator accepted for promotion — stamped after the writes land. */
  readonly acceptedIds?: readonly string[];
}
