/**
 * `ChainSharedDeps` — the subset of {@link SharedDeps} the chain factories
 * actually consume.
 *
 * Chain factories accept this narrower view (instead of the full
 * `SharedDeps`) for two reasons:
 *
 *  1. **Test ergonomics** — tests build a focused fake graph via
 *     `createTestDeps()` rather than constructing the full composition
 *     root. The narrower view means tests don't have to fake the
 *     signal bus, jsonl writer, session manager, etc., that no chain
 *     factory ever touches.
 *  2. **Architectural clarity** — reading a chain factory's signature
 *     tells you exactly which ports the workflow depends on, without
 *     "anywhere we feel like" reaching into the full graph.
 *
 * `ChainSharedDeps` is structurally compatible with `SharedDeps` — every
 * field listed here is a subset of the full graph. CLI / TUI call sites
 * pass `SharedDeps` directly; TypeScript narrows to this view at the
 * factory boundary.
 *
 * Skill linking is typed against {@link SessionSkillsLinkerLike} — the
 * narrow chain-side interface — so chains stay agnostic to which
 * concrete linker the integration adapter wires in.
 */
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { ExternalPort } from '@src/business/ports/external-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';
import type { PromptPort } from '@src/business/ports/prompt-port.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus-port.ts';
import type { SignalHandlerPort } from '@src/business/ports/signal-handler-port.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser-port.ts';
import type { SessionFolderBuilderPort } from '@src/business/ports/session-folder-builder-port.ts';
import type { WriteContextFilePort } from '@src/business/ports/write-context-file-port.ts';
import type { ProjectRepository } from '@src/domain/repositories/project-repository.ts';
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repositories/task-repository.ts';
import type { RateLimitCoordinator } from '@src/kernel/algorithms/rate-limit-coordinator.ts';
import type { LiveConfigReader } from '@src/application/runtime/live-config-reader.ts';
import type { SessionSkillsLinkerLike } from './leaves/link-skills.ts';

export interface ChainSharedDeps {
  readonly sprintRepo: SprintRepository;
  readonly projectRepo: ProjectRepository;
  readonly taskRepo: TaskRepository;
  readonly aiSession: AiSessionPort;
  readonly prompts: PromptBuilderPort;
  readonly external: ExternalPort;
  readonly signalParser: SignalParserPort;
  readonly logger: LoggerPort;
  /**
   * Live-reads the current config on demand. Per-task chains thread
   * this into the multi-round evaluator loop so settings-panel edits
   * apply on the next round without restart (REQ-12).
   */
  readonly liveConfig: LiveConfigReader;
  readonly skillsLinker: SessionSkillsLinkerLike;
  /**
   * Interactive prompt port. Onboarding's confirmation leaves need to
   * surface the AI proposal to the user inline; other chains may use
   * this for in-flight confirmations as well.
   */
  readonly prompt: PromptPort;
  /**
   * Live observability stream. The per-task chain forwards parsed harness
   * signals (and the use case forwards them too) so the dashboard's
   * "Recent events" panel renders `<progress>`, `<note>`, `<task-verified>`,
   * etc. in real time. Auto-tagged with the active session id via ALS.
   */
  readonly signalBus: SignalBusPort;
  /**
   * Global rate-limit coordinator. `ExecuteSingleTaskUseCase` calls
   * `coordinator.pause(reason)` when a spawn returns a 429 hint and
   * `resume()` once the cooldown elapses; the coordinator's events
   * bridge to `SignalBusPort` so the dashboard's `RateLimitBanner`
   * reflects pause/resume state.
   */
  readonly rateLimitCoordinator: RateLimitCoordinator;
  /**
   * Per-task context-file writer. Every chain that spawns an AI session
   * runs through the `render-prompt-to-file` leaf, which uses this port
   * to write a rich markdown context file under
   * `<sprintDir>/contexts/<flow>-<id>.md` and stamps the absolute path
   * on the chain context for the downstream spawn leaf. Narrow port
   * (one method) so we keep the layered architecture without inflating
   * to a generic filesystem port.
   */
  readonly writeContextFile: WriteContextFilePort;
  /**
   * Materialises per-unit sandbox folders under
   * `<sprintDir>/{refinement,ideation,planning,execution}/`. Refine /
   * ideate / plan / per-task chains spawn AI sessions inside these
   * folders so the agent never touches the user's real repos by
   * accident (with the deliberate exception of execution where the
   * generator runs in `task.projectPath`). Consumed by
   * `buildRefinementUnitLeaf`, `buildPlanningFolderLeaf`, and
   * `buildExecutionUnitLeaf`.
   */
  readonly sessionFolderBuilder: SessionFolderBuilderPort;
  /**
   * Durable signal persistence. Wired into `EvaluateTaskUseCase` so
   * each evaluator round writes its `EvaluationSignal` to
   * `execution/<unit-slug>/evaluation.md`. Best-effort — handler
   * failures log a warning and do not abort the chain.
   */
  readonly signalHandler: SignalHandlerPort;
}
