import type { PullRequestCreator } from '@src/business/scm/pull-request-creator.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Dependency contract for the create-pr flow.
 *
 * The AI-step fields (`provider`, `templateLoader`, `writeFile`, `logger`, `model`) are
 * always present even though they're only exercised when `useAi=true` at flow construction.
 * Threading them unconditionally keeps the CLI / TUI surfaces symmetric — callers don't
 * inspect `useAi` to pick a dep bundle — and the AI leaves are simply not in the chain
 * when the flag is off.
 */
export interface CreatePrDeps {
  readonly sprintRepo: SprintRepository;
  readonly sprintExecutionRepo: SprintExecutionRepository;
  /**
   * Slim repo port used to enrich the derived PR body with the sprint's completed tasks.
   * Loaded inside the flow so the CLI / TUI callers don't have to pre-load — the chain's
   * single I/O step keeps the call-sites symmetric across surfaces.
   */
  readonly taskRepo: FindTasksBySprintId;
  readonly pullRequestCreator: PullRequestCreator;
  /**
   * Used by the upstream `push-branch` leaf to verify the working tree is on the sprint
   * branch and to `git push -u origin <branch>` before the platform CLI sees the head.
   * In non-TTY spawns the platform CLI cannot prompt the user to push, so the harness
   * must publish the branch itself.
   */
  readonly gitRunner: GitRunner;
  readonly eventBus: EventBus;
  readonly clock: () => IsoTimestamp;
  /** Headless AI provider — used by the optional generate-pr-content leaf. */
  readonly provider: HeadlessAiProvider;
  /** Template loader for the create-pr prompt — used by the optional AI step. */
  readonly templateLoader: TemplateLoader;
  /**
   * Atomic file writer — used by the AI sub-chain to write `prompt.md` before the spawn and
   * `pr-content.md` (sidecar) after validation.
   */
  readonly writeFile: WriteFile;
  /** Logger — used by the AI sub-chain to surface fallback reasons at warn level. */
  readonly logger: Logger;
  /** Model identifier — picked from `settings.ai.refine.model` for now; see flow.ts TODO. */
  readonly model: string;
}
