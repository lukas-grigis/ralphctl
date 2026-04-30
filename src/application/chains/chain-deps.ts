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
import type { AiSessionPort } from '../../business/ports/ai-session-port.ts';
import type { ExternalPort } from '../../business/ports/external-port.ts';
import type { LoggerPort } from '../../business/ports/logger-port.ts';
import type { PromptBuilderPort } from '../../business/ports/prompt-builder-port.ts';
import type { PromptPort } from '../../business/ports/prompt-port.ts';
import type { SignalParserPort } from '../../business/ports/signal-parser-port.ts';
import type { ProjectRepository } from '../../domain/repositories/project-repository.ts';
import type { SprintRepository } from '../../domain/repositories/sprint-repository.ts';
import type { TaskRepository } from '../../domain/repositories/task-repository.ts';
import type { LiveConfigReader } from '../runtime/live-config-reader.ts';
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
}
