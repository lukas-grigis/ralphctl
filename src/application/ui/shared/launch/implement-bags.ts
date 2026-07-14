/**
 * Pure bag-assembly helpers for the implement launcher — `ImplementDeps` / `CreateImplementFlowOpts`
 * plus the per-role provider + model/effort resolution that feeds both. Split out of
 * `launch/implement.ts` (which composes these bags into the chain element) so that file stays
 * under the line-count ratchet.
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
 * Build one `HeadlessAiProvider` per role from the effective implement pair. The two roles may
 * target distinct providers — they're constructed independently rather than routed through
 * `primaryFlowRow` so a cross-provider configuration spawns the right CLI per role. `ctx.provider`
 * (the launcher-rebuilt primary adapter) is deliberately left unused by the implement launcher —
 * implement bypasses the single-row seam.
 *
 * `resolveAgentOverride` applies the bound-definition > per-flow-row > global-default precedence
 * per role — `createAiProvider` only dispatches on `row.provider` (never `row.model`), so a
 * definition-supplied model never needs to change WHICH provider adapter is constructed, only the
 * `model`/`effort` this function returns for the spawn + the escalation baseline downstream.
 *
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
  });
  const evaluatorProvider = createAiProvider({
    row: implementPair.evaluator,
    harnessConfig: effectiveSettings.harness,
    eventBus: deps.app.eventBus,
  });
  const generatorResolved = resolveAgentOverride(
    implementPair.generator,
    effectiveSettings.ai.effort,
    agentDefinitions.generator
  );
  const evaluatorResolved = resolveAgentOverride(
    implementPair.evaluator,
    effectiveSettings.ai.effort,
    agentDefinitions.evaluator
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
  // ONE journal mutex per run. Every parallel branch inherits this instance (branches spread this
  // deps bag), so their `progress-journal-<taskId>` leaves serialise their read-regenerate-write
  // of the shared `progress.md` through it; the serial path is a single caller, so it is a no-op.
  journalMutex: createFoldQueue(),
});

/**
 * Assemble the `CreateImplementFlowOpts` bag — pure object-literal assembly, no branching.
 * `repositories` is derived here (via {@link buildRepoExecConfigs}) rather than passed in, so
 * callers only need to hand over the raw project. `providers.generatorModel`/`evaluatorModel`
 * already carry the bound-definition override (see `buildImplementProviders`), so this bag — and
 * every downstream consumer that reads `CreateImplementFlowOpts.generatorModel`/`generatorEffort`
 * (the gen-eval spawn AND `finalize-gen-eval`'s escalation baseline both read the SAME field) —
 * sees the overridden value without a second resolution.
 *
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
