import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

export interface CreatePrInput {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly base: string;
  readonly draft: boolean;
  /** Pre-loaded tasks to feed the body deriver. Empty omits the `## Tasks` section. */
  readonly tasks?: readonly Task[];
  /** Override for derived title. */
  readonly title?: string;
  /** Override for derived body. */
  readonly body?: string;
  /**
   * AI-authored title + body to thread into the PR. When set, precedence is
   * `explicit override > aiContent > template`. The AI sub-chain populates this on ctx;
   * the create-pr leaf reads it as input via the ctx-input projection. Optional because
   * the AI step is opt-out (`--no-ai`) and can also degrade silently to the template.
   */
  readonly aiContent?: { readonly title: string; readonly body: string };
}

export interface CreatePrOutput {
  readonly url: string;
}

/**
 * Chain context. Optional fields are populated by upstream leaves of the AI sub-chain:
 *   `sprint`, `tasks`, `headBranch` — set by the load-create-pr-context leaf.
 *   `currentUnitRoot`, `currentPromptFile` — set by build-create-pr-unit / render-prompt-to-file.
 *   `aiContent` — set by generate-pr-content when the AI authoring succeeds.
 *
 * When `useAi=false` (the `--no-ai` CLI flag, or the `a` toggle in the TUI) none of the
 * optional fields are populated and the create-pr leaf falls back to `derivePrContent`.
 */
export interface CreatePrCtx {
  readonly input: CreatePrInput;
  readonly output?: CreatePrOutput;
  /** Loaded sprint — set by the load-context leaf at the head of the AI sub-chain. */
  readonly sprint?: Sprint;
  /** Sprint tasks — set by the load-context leaf so the AI prompt can summarise them. */
  readonly tasks?: readonly Task[];
  /** Resolved sprint branch (already pushed by the upstream push-branch leaf). */
  readonly headBranch?: string;
  /** Per-flow sandbox folder under `<sprintDir>/create-pr/<run-slug>/`. */
  readonly currentUnitRoot?: AbsolutePath;
  /** `<unitRoot>/prompt.md` — written by render-prompt-to-file. */
  readonly currentPromptFile?: AbsolutePath;
  /** Validated AI-authored proposal — projected by `generate-pr-content` when successful. */
  readonly aiContent?: { readonly title: string; readonly body: string };
}
