import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Narrow dependency contract for the ideate chain. Always interactive — uses
 * {@link InteractiveAiProvider} for the combined refine + plan AI session, and
 * `runInTerminal` to pause the host TUI while Claude takes over the terminal.
 */
export interface IdeateDeps {
  readonly sprintRepo: SprintRepository;
  readonly projectRepo: ProjectRepository;
  readonly taskRepo: TaskRepository;
  readonly interactiveAi: InteractiveAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly writeFile: WriteFile;
  readonly runInTerminal: RunInTerminal;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly skillsAdapter: SkillsAdapter;
  readonly skillSource: SkillSource;
  /** ISO timestamp source — stamped onto the per-spawn `meta.json` sidecar. */
  readonly clock: () => IsoTimestamp;
}
