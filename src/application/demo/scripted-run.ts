/**
 * `ralphctl demo --script` — the reproducible recording mode.
 *
 * `seedDemoWorkspace` builds the sandbox; this module takes that sandbox and makes it safe to
 * replay a canned session against, then hands back the {@link ProviderSpawn} the TUI launch
 * threads into `wire()`. Three adjustments, each of which exists because a real first-run
 * machine cannot be assumed to look like a maintainer's:
 *
 *  1. **Pin every AI row to `claude-code`.** The scripted spawn emulates exactly one CLI's
 *     stream format; the shipped default splits the implement roles across two providers.
 *  2. **Turn the escalation rungs off and leave the turn budget at the default.** The transcript
 *     is two rounds; best-of-N / plateau escalation would fire on a path the recording is not
 *     meant to show.
 *  3. **Rewrite the seeded verify script + acceptance criterion to node one-liners.** The seed
 *     uses `python3 hello.py`, which is not portable, and the verify script must stay GREEN at
 *     the baseline — a red pre-task-verify opens the "proceed on a broken tree?" operator gate,
 *     which is not the first-run story. The red → green transition lives on the acceptance
 *     criterion instead, which is exactly where the scripted evaluator grades it.
 *
 * Idempotent: re-running against an already-prepared sandbox rewrites the same values.
 *
 * Wiring (one line in `ralphctl demo`'s action, after seeding):
 *
 *     const scripted = await prepareScriptedDemo({ homeDir });
 *     if (!scripted.ok) return fail(scripted.error.message);
 *     await launchTui({ providerSpawn: scripted.value.providerSpawn });
 */

import { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS, defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';
import { storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { createDemoProviderSpawn } from '@src/application/demo/scripted-spawn.ts';
import { DEMO_CRITERION_COMMAND, DEMO_VERIFY_SCRIPT, demoTranscript } from '@src/application/demo/transcript.ts';

export interface PrepareScriptedDemoInput {
  /** Sandbox app root — the same `homeDir` that was handed to `seedDemoWorkspace`. */
  readonly homeDir: AbsolutePath;
  /** Clock for the transcript's signal timestamps. Tests pin it; production omits it. */
  readonly now?: () => IsoTimestamp;
}

export interface PreparedScriptedDemo {
  /** Hand to `launchTui({ providerSpawn })`. */
  readonly providerSpawn: ProviderSpawn;
  /** The settings written into the sandbox — returned so the caller can report what was pinned. */
  readonly settings: Settings;
}

/**
 * Settings the scripted demo runs under. Everything not named here stays at the shipped default,
 * so the recording still shows the product's real behaviour.
 */
const scriptedDemoSettings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  ai: defaultAiSettingsForProvider('claude-code'),
  harness: {
    ...DEFAULT_SETTINGS.harness,
    // The transcript converges on round 2; a rung that fires past it would spawn a session the
    // transcript has no beat for.
    bestOfNCandidates: 0,
    escalateOnPlateau: false,
  },
});

const withDemoVerifyScript = (project: Project): Project => ({
  ...project,
  repositories: project.repositories.map((repo) => ({ ...repo, verifyScript: DEMO_VERIFY_SCRIPT })),
});

const withDemoCriterionCommand = (task: Task): Task => ({
  ...task,
  verificationCriteria: task.verificationCriteria.map((criterion) =>
    criterion.check === 'auto' ? { ...criterion, command: DEMO_CRITERION_COMMAND } : criterion
  ),
});

/**
 * Pin the sandbox's settings and rewrite its seeded commands for a scripted run, then build the
 * transcript-replaying spawn. Call AFTER `seedDemoWorkspace` — this function only ever rewrites
 * what the seeder already wrote, it never creates a workspace.
 *
 * @public
 */
export const prepareScriptedDemo = async (
  input: PrepareScriptedDemoInput
): Promise<Result<PreparedScriptedDemo, DomainError>> => {
  const paths = storagePathsFromRoot(input.homeDir);
  if (!paths.ok) return Result.error(paths.error);

  const settings = scriptedDemoSettings();
  const saved = await createJsonSettingsRepository({ configRoot: paths.value.configRoot }).save(settings);
  if (!saved.ok) return Result.error(saved.error);

  const projectRepo = createFsProjectRepository({ root: paths.value.dataRoot });
  const projects = await projectRepo.list();
  if (!projects.ok) return Result.error(projects.error);
  for (const project of projects.value) {
    const written = await projectRepo.save(withDemoVerifyScript(project));
    if (!written.ok) return Result.error(written.error);
  }

  const sprintRepo = createFsSprintRepository({ root: paths.value.dataRoot });
  const taskRepo = createFsTaskRepository({ root: paths.value.dataRoot });
  const sprints = await sprintRepo.list();
  if (!sprints.ok) return Result.error(sprints.error);
  for (const sprint of sprints.value) {
    const tasks = await taskRepo.findBySprintId(sprint.id);
    if (!tasks.ok) return Result.error(tasks.error);
    if (tasks.value.length === 0) continue;
    const written = await taskRepo.saveAll(sprint.id, tasks.value.map(withDemoCriterionCommand));
    if (!written.ok) return Result.error(written.error);
  }

  const transcript = input.now === undefined ? demoTranscript() : demoTranscript(input.now);
  return Result.ok({ providerSpawn: createDemoProviderSpawn(transcript), settings });
};
