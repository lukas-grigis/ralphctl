/**
 * Pure bag-assembly helpers for the implement launcher — `ImplementDeps` / `CreateImplementFlowOpts` plus the
 * per-role provider + model/effort resolution that feeds both.
 */

import type { CreateImplementFlowOpts, RepoExecConfig } from '@src/application/flows/implement/flow.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { createFoldQueue } from '@src/application/flows/implement/wave-branch.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { type AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { PublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import type { AiImplementSettings, Settings } from '@src/domain/entity/settings.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import { resolveAgentOverride } from '@src/business/settings/resolve-agent-override.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import type { RoleAgentBinding } from '@src/application/ui/shared/launch/implement-agent-bindings.ts';
import type { LauncherDeps } from '@src/application/ui/shared/launcher.ts';

/** Project repositories → `RepoExecConfig` map keyed by id, the per-task subchain's repo lookup. */
export const buildRepoExecConfigs = (repositories: readonly Repository[]): Map<RepositoryId, RepoExecConfig> => {
  const configs = new Map<RepositoryId, RepoExecConfig>();
  for (const r of repositories) {
    configs.set(r.id, {
      path: r.path,
      name: r.name,
      ...(r.verifyScript !== undefined ? { verifyScript: r.verifyScript } : {}),
      ...(r.verifyGates !== undefined ? { verifyGates: r.verifyGates } : {}),
      ...(r.verifyTimeout !== undefined ? { verifyTimeout: r.verifyTimeout } : {}),
      ...(r.setupScript !== undefined ? { setupScript: r.setupScript } : {}),
    });
  }
  return configs;
};

/**
 * Build one `HeadlessAiProvider` per role from the effective implement pair.
 * @public
 */
export const buildImplementProviders = (
  implementPair: AiImplementSettings,
  effectiveSettings: Settings,
  deps: LauncherDeps,
  agentDefinitions: { readonly generator?: AgentDefinition; readonly evaluator?: AgentDefinition } = {}
): {
  readonly generatorProvider: HeadlessAiProvider;
  readonly evaluatorProvider: HeadlessAiProvider;
  readonly generatorModel: string;
  readonly evaluatorModel: string;
  readonly generatorEffort: string | undefined;
  readonly evaluatorEffort: string | undefined;
} => {
  const generatorProvider = createAiProvider({
    row: implementPair.generator,
    harnessConfig: effectiveSettings.harness,
    eventBus: deps.app.eventBus,
    childRegistry: deps.app.childRegistry,
  });
  const evaluatorProvider = createAiProvider({
    row: implementPair.evaluator,
    harnessConfig: effectiveSettings.harness,
    eventBus: deps.app.eventBus,
    childRegistry: deps.app.childRegistry,
  });
  const generatorResolved = resolveAgentOverride(
    implementPair.generator,
    effectiveSettings.ai.effort,
    agentDefinitions.generator,
    'implement'
  );
  const evaluatorResolved = resolveAgentOverride(
    implementPair.evaluator,
    effectiveSettings.ai.effort,
    agentDefinitions.evaluator,
    'implement'
  );
  return {
    generatorProvider,
    evaluatorProvider,
    generatorModel: generatorResolved.model,
    evaluatorModel: evaluatorResolved.model,
    generatorEffort: generatorResolved.effort,
    evaluatorEffort: evaluatorResolved.effort,
  };
};

/** Assemble the `ImplementDeps` bag handed to `createImplementFlow` / `buildParallelElement`. */
export const buildImplementDepsBag = (
  deps: LauncherDeps,
  effectiveSettings: Settings,
  publishSignal: PublishSignal,
  providers: { readonly generatorProvider: HeadlessAiProvider; readonly evaluatorProvider: HeadlessAiProvider },
  skillsAdapter: SkillsAdapter,
  skillSource: SkillSource,
  agentDefinitionAdapters: { readonly generator: AgentDefinitionAdapter; readonly evaluator: AgentDefinitionAdapter }
): ImplementDeps => ({
  sprintRepo: deps.app.sprintRepo,
  sprintExecutionRepo: deps.app.sprintExecutionRepo,
  taskRepo: deps.app.taskRepo,
  generatorProvider: providers.generatorProvider,
  evaluatorProvider: providers.evaluatorProvider,
  templateLoader: deps.app.templateLoader,
  publishSignal,
  eventBus: deps.app.eventBus,
  logger: deps.app.logger,
  clock: deps.app.clock,
  config: effectiveSettings,
  gitRunner: deps.app.gitRunner,
  shellScriptRunner: deps.app.shellScriptRunner,
  fileLocker: deps.app.fileLocker,
  locksRoot: deps.storage.locksRoot,
  skillsAdapter,
  skillSource,
  generatorAgentDefinitionAdapter: agentDefinitionAdapters.generator,
  evaluatorAgentDefinitionAdapter: agentDefinitionAdapters.evaluator,
  interactive: deps.interactive,
  writeFile: deps.app.writeFile,
  appendFile: deps.app.appendFile,
  // ONE journal mutex per run.
  journalMutex: createFoldQueue(),
  // ONE ledger mutex per run, for the same reason: every parallel branch's `append-learnings-<taskId>` writes the
  // SAME project `learnings.ndjson`.
  ledgerMutex: createFoldQueue(),
});

/**
 * Assemble the `CreateImplementFlowOpts` bag — pure object-literal assembly, no branching.
 * @public
 */
export const buildImplementOptsBag = (
  sprint: Pick<Sprint, 'id'>,
  project: Pick<Project, 'id' | 'slug' | 'repositories'>,
  todoTasks: readonly Task[],
  sprintPaths: { readonly progressPath: AbsolutePath; readonly sprintDirPath: AbsolutePath },
  implementPair: AiImplementSettings,
  providers: {
    readonly generatorModel: string;
    readonly evaluatorModel: string;
    readonly generatorEffort: string | undefined;
    readonly evaluatorEffort: string | undefined;
  },
  memoryRoot: AbsolutePath,
  agentBindings: { readonly generator: RoleAgentBinding; readonly evaluator: RoleAgentBinding } = {
    generator: {},
    evaluator: {},
  }
): CreateImplementFlowOpts => ({
  sprintId: sprint.id,
  todoTasks,
  repositories: buildRepoExecConfigs(project.repositories),
  progressFile: sprintPaths.progressPath,
  sprintDir: sprintPaths.sprintDirPath,
  generatorProviderId: implementPair.generator.provider,
  generatorModel: providers.generatorModel,
  ...(providers.generatorEffort !== undefined ? { generatorEffort: providers.generatorEffort } : {}),
  evaluatorProviderId: implementPair.evaluator.provider,
  evaluatorModel: providers.evaluatorModel,
  ...(providers.evaluatorEffort !== undefined ? { evaluatorEffort: providers.evaluatorEffort } : {}),
  ...(agentBindings.generator.definition !== undefined
    ? { generatorAgentDefinition: agentBindings.generator.definition }
    : {}),
  ...(agentBindings.generator.section !== undefined
    ? { generatorAgentDefinitionSection: agentBindings.generator.section }
    : {}),
  ...(agentBindings.evaluator.definition !== undefined
    ? { evaluatorAgentDefinition: agentBindings.evaluator.definition }
    : {}),
  ...(agentBindings.evaluator.section !== undefined
    ? { evaluatorAgentDefinitionSection: agentBindings.evaluator.section }
    : {}),
  memoryRoot,
  projectId: String(project.id),
  projectSlug: project.slug,
});
