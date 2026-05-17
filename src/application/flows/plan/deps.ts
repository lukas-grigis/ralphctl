import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { DraftSprint } from '@src/domain/entity/sprint.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { TodoTask } from '@src/domain/entity/task.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';

/**
 * Narrow dependency contract for the plan chain. **Always interactive** — uses
 * {@link InteractiveAiProvider} (not the headless variant), pauses the host TUI via
 * `runInTerminal` while Claude takes over the terminal, and reads the planner's output from
 * a JSON file.
 */
export interface PlanDeps {
  readonly sprintRepo: SprintRepository;
  readonly sprintExecutionRepo: SprintExecutionRepository;
  readonly projectRepo: ProjectRepository;
  readonly taskRepo: TaskRepository;
  readonly interactiveAi: InteractiveAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly writeFile: WriteFile;
  readonly runInTerminal: RunInTerminal;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
  readonly skillsAdapter: SkillsAdapter;
  readonly skillSource: SkillSource;
  /**
   * Optional HITL approval hook. The launcher wires a TUI confirm prompt that summarises the
   * proposed task list and asks accept/reject; when omitted (CI / headless) the AI's plan is
   * auto-accepted. Mirrors the pattern used by the refine flow.
   */
  readonly reviewBeforeApprove?: (
    proposedTasks: readonly TodoTask[],
    sprint: DraftSprint
  ) => Promise<{ readonly accept: boolean }>;
}
