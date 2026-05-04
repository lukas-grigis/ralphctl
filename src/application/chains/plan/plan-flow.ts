/**
 * `createPlanFlow` — chain definition for the plan / replan workflow.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-draft → assert-all-tickets-approved →
 *     persist-repo-selection → load-existing-tasks → snapshot-existing-tasks →
 *     build-planning-folder → link-skills → confirm-replan →
 *     render-prompt-to-file → plan-tasks → reorder-tasks → confirm-task-list →
 *     save-tasks → unlink-skills
 *
 * The use case (`PlanSprintTasksUseCase`) re-checks the same
 * preconditions internally, but the chain still surfaces them as
 * distinct trace entries so a debug session pinpoints which gate failed
 * without diving into the use case code.
 *
 * `persist-repo-selection` runs the repo-pick checkbox UI inside the
 * chain (single-repo projects skip the prompt) and writes the result
 * onto `sprint.affectedRepositories`. Downstream `build-plan-workspace`
 * then reads those repos and stamps `ctx.cwd` (the sandbox root) and
 * `ctx.planAddDirs` (the affected-repo paths to surface as `--add-dir`
 * to Claude; Copilot mirrors them inside the sandbox instead).
 *
 * `build-plan-workspace` materialises a sandbox under
 * `<sprintDir>/workspaces/plan/` and pre-stages contract files
 * (per-ticket refined requirements, sprint metadata, provider-native
 * context file). The AI session spawns inside this sandbox rather than
 * the user's first repo so `.claude/skills/` and any AI write-tool side
 * effects never touch tracked files. Affected repos remain readable via
 * `--add-dir` (Claude) or the read-only mirror under
 * `<root>/repos/<basename>/` (Copilot). Existing tasks (when re-planning)
 * are inlined into `prompt.md` itself by the prompt builder — no
 * separate sidecar file.
 *
 * `link-skills` runs AFTER `build-plan-workspace` so the bundled-skill
 * tree lands inside the workspace's `.claude/skills/` rather than the
 * user's repo. The repo-pick prompt that runs above this point is a
 * pure UI prompt — it doesn't consume bundled skills, so deferring the
 * skills install is safe.
 *
 * `render-prompt-to-file` writes the FULL plan prompt (sprint context,
 * tickets with refined requirements, existing tasks for replan,
 * harness context, signal vocabulary, schema) directly into the
 * planning unit folder at `<sprintDir>/planning/prompt.md` so the
 * sandbox stays self-contained — the prompt sits next to `session.md`,
 * `tasks.json`, the provider-native context file, and the
 * `.claude/skills/` overlay. Mirrors the refine flow's per-unit layout.
 * The downstream `plan-tasks` leaf hands the AI a thin wrapper pointing
 * at that file.
 *
 * `unlink-skills` is the very last leaf so a save-tasks failure still
 * cleans up. Plan uses its own `'plan'` phase folder on top of
 * `default/` — see the skills lifecycle bullet in CLAUDE.md.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Result } from '@src/domain/result.ts';

import type { Project } from '@src/domain/entities/project.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import { PlanSprintTasksUseCase } from '@src/business/usecases/plan/plan-sprint-tasks.ts';
import type { Task } from '@src/domain/entities/task.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { AbsolutePath as AbsolutePathVO } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import { assertDraftLeaf } from '@src/application/chains/leaves/assert-draft.ts';
import { buildPlanningFolderLeaf } from '@src/application/chains/leaves/build-planning-folder.ts';
import { linkSkillsLeaf } from '@src/application/chains/leaves/link-skills.ts';
import { loadSprintLeaf } from '@src/application/chains/leaves/load-sprint.ts';
import { loadTasksLeaf } from '@src/application/chains/leaves/load-tasks.ts';
import { renderPromptToFileLeaf } from '@src/application/chains/leaves/render-prompt-to-file.ts';
import { reorderTasksLeaf } from '@src/application/chains/leaves/reorder-tasks.ts';
import { saveTasksLeaf } from '@src/application/chains/leaves/save-tasks.ts';
import { unlinkSkillsLeaf } from '@src/application/chains/leaves/unlink-skills.ts';

export interface PlanCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint;
  /** Pre-existing tasks loaded by `load-existing-tasks`; replaced by `plan-tasks`. */
  readonly tasks?: readonly Task[];
  /**
   * Sandbox workspace root. Set by the `build-plan-workspace` leaf
   * during the chain run — callers do NOT pass this as initial input.
   * Downstream leaves (skills install, AI session spawn, …) read from
   * here so every IO lands inside the sandbox rather than the user's
   * repo.
   */
  readonly cwd?: AbsolutePath;
  /**
   * Affected-repo paths to forward to the AI session as `--add-dir`
   * flags (Claude only). Set by the `build-plan-workspace` leaf;
   * empty for Copilot, which has the repos mirrored inside the
   * sandbox under `<root>/repos/<basename>/` instead.
   */
  readonly planAddDirs?: readonly AbsolutePath[];
  /**
   * Resolved plan prompt file path. Set by `render-prompt-to-file`;
   * consumed by `plan-tasks`.
   */
  readonly promptFilePath?: AbsolutePathVO;
  /**
   * Per-sprint planning folder root. Set by `build-planning-folder`.
   */
  readonly planningFolderRoot?: AbsolutePath;
  /**
   * Audit `session.md` path under the planning folder. Set by
   * `build-planning-folder`; consumed by `plan-tasks` to pass into
   * the AI session adapter as `SessionOptions.sessionMdPath`.
   */
  readonly planningSessionMdPath?: AbsolutePath;
}

export interface CreatePlanFlowOpts {
  readonly sprintId: SprintId;
  /**
   * When true, run Claude with stdio: 'inherit' and read tasks JSON
   * from `outputFilePath`. Defaults to false (headless / stdout parse).
   */
  readonly interactive?: boolean;
  /** Required when `interactive` is true — see PlanSprintTasksInput. */
  readonly outputFilePath?: string;
  /** Required when `interactive` is true — Ink-pause + spawn handover. */
  readonly runInTerminal?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function createPlanFlow(
  deps: Pick<
    ChainSharedDeps,
    | 'sprintRepo'
    | 'projectRepo'
    | 'taskRepo'
    | 'aiSession'
    | 'prompts'
    | 'logger'
    | 'prompt'
    | 'skillsLinker'
    | 'writeContextFile'
    | 'sessionFolderBuilder'
  >,
  opts: CreatePlanFlowOpts
): Element<PlanCtx> {
  const planUseCase = new PlanSprintTasksUseCase(deps.aiSession, deps.logger);

  const renderPromptStep = renderPromptToFileLeaf<PlanCtx>(
    { writeContextFile: deps.writeContextFile },
    {
      flowName: 'plan',
      identifier: () => '',
      // Drop the prompt directly inside the planning unit folder so the
      // sandbox is self-contained (mirrors refine's `prompt.md` layout).
      // `build-planning-folder` runs upstream and stamps
      // `planningFolderRoot` onto ctx.
      path: (ctx) => {
        if (!ctx.planningFolderRoot) {
          throw new Error('render-prompt-to-file: ctx.planningFolderRoot must be set by build-planning-folder');
        }
        return AbsolutePath.trustString(join(String(ctx.planningFolderRoot), 'prompt.md'));
      },
      buildPrompt: (ctx) => {
        if (!ctx.sprint) {
          // Programmer error — the upstream `load-sprint` leaf must
          // have run by now. Throw rather than return Result.error so
          // the failure surfaces with a stack trace instead of being
          // routed through the placeholder-fence error path.
          throw new Error('render-prompt-to-file: ctx.sprint must be loaded first');
        }
        return deps.prompts.buildPlanPrompt({
          sprint: ctx.sprint,
          existingTasks: ctx.tasks ?? [],
          ...(opts.outputFilePath !== undefined ? { outputFilePath: opts.outputFilePath } : {}),
        });
      },
    }
  );

  return new Sequential<PlanCtx>('plan', [
    loadSprintLeaf<PlanCtx>({ sprintRepo: deps.sprintRepo }),
    assertDraftLeaf<PlanCtx>('plan'),
    assertAllTicketsApprovedLeaf(),
    persistRepoSelectionLeaf(deps),
    loadTasksLeaf<PlanCtx>({ taskRepo: deps.taskRepo }, 'load-existing-tasks'),
    snapshotExistingTasksLeaf(deps),
    buildPlanningFolderLeaf<PlanCtx>({
      sessionFolderBuilder: deps.sessionFolderBuilder,
      aiSession: deps.aiSession,
    }),
    linkSkillsLeaf<PlanCtx>({ skillsLinker: deps.skillsLinker }, { phase: 'plan' }),
    confirmReplanLeaf(deps, opts),
    renderPromptStep,
    planTasksLeaf(planUseCase, opts),
    reorderTasksLeaf<PlanCtx>(),
    confirmTaskListLeaf(deps, opts),
    saveTasksLeaf<PlanCtx>({ taskRepo: deps.taskRepo }),
    unlinkSkillsLeaf<PlanCtx>({ skillsLinker: deps.skillsLinker }),
  ]);
}

/**
 * Pre-plan replan gate: when `ctx.tasks` is non-empty (a prior plan
 * exists for this sprint) and we're in interactive mode, ask the user
 * whether they really want to replace the existing tasks. Headless / CI
 * proceeds silently — that's the contract for an `--auto` run.
 */
function confirmReplanLeaf(
  deps: Pick<ChainSharedDeps, 'prompt' | 'logger'>,
  opts: CreatePlanFlowOpts
): Element<PlanCtx> {
  return new Leaf<PlanCtx, { readonly existingTasks: readonly Task[]; readonly interactive: boolean }, void>(
    'confirm-replan',
    {
      useCase: {
        async execute(input) {
          if (!input.interactive || input.existingTasks.length === 0) {
            return Result.ok(undefined);
          }
          const proceed = await deps.prompt.confirm({
            message: `${String(input.existingTasks.length)} task(s) already exist for this sprint. Re-planning will replace them all. Continue?`,
            default: true,
          });
          if (!proceed) {
            deps.logger.info('plan: user cancelled replan');
            return Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: 'replan-cancelled',
                attemptedAction: 'plan',
                message: 'replan cancelled by user',
              })
            );
          }
          return Result.ok(undefined);
        },
      },
      input: (ctx) => ({
        existingTasks: ctx.tasks ?? [],
        interactive: opts.interactive === true,
      }),
      output: (ctx) => ctx,
    }
  );
}

/**
 * Post-plan acceptance gate: shows the parsed task list and asks the
 * user to confirm before save-tasks persists. Decline → return an
 * `InvalidStateError` so the chain ends in `failed` and save-tasks
 * never runs (atomic — nothing gets written if the user said no).
 * Headless skips silently.
 */
function confirmTaskListLeaf(
  deps: Pick<ChainSharedDeps, 'prompt' | 'logger'>,
  opts: CreatePlanFlowOpts
): Element<PlanCtx> {
  return new Leaf<PlanCtx, { readonly tasks: readonly Task[]; readonly interactive: boolean }, void>(
    'confirm-task-list',
    {
      useCase: {
        async execute(input) {
          if (!input.interactive || input.tasks.length === 0) {
            return Result.ok(undefined);
          }
          const summary = renderTaskListSummary(input.tasks);
          const accept = await deps.prompt.confirm({
            message: `Approve the planned tasks and save?`,
            details: summary,
            default: true,
          });
          if (!accept) {
            deps.logger.info('plan: user rejected task list');
            return Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: 'task-list-rejected',
                attemptedAction: 'plan',
                message: 'planned tasks rejected by user — nothing saved',
              })
            );
          }
          return Result.ok(undefined);
        },
      },
      input: (ctx) => ({
        tasks: ctx.tasks ?? [],
        interactive: opts.interactive === true,
      }),
      output: (ctx) => ctx,
    }
  );
}

/** Compact list rendering for the post-plan confirm prompt. */
function renderTaskListSummary(tasks: readonly Task[]): string {
  const lines: string[] = [];
  lines.push(`${String(tasks.length)} task(s) planned:`);
  for (const t of tasks) {
    const blocks = t.blockedBy.length > 0 ? ` (blockedBy: ${t.blockedBy.map(String).join(', ')})` : '';
    lines.push(`  ${String(t.order)}. ${t.name}${blocks}`);
    lines.push(`     ${String(t.projectPath)}`);
  }
  return lines.join('\n');
}

function planTasksLeaf(useCase: PlanSprintTasksUseCase, opts: CreatePlanFlowOpts): Element<PlanCtx> {
  return new Leaf<
    PlanCtx,
    {
      readonly sprint: Sprint;
      readonly existingTasks: readonly Task[];
      readonly cwd: AbsolutePath;
      readonly additionalRepoPaths: readonly AbsolutePath[];
      readonly promptFilePath: AbsolutePathVO;
      readonly sessionMdPath?: AbsolutePath;
    },
    readonly Task[]
  >('plan-tasks', {
    useCase: {
      async execute(input) {
        // Claude's Write tool can't create intermediate directories,
        // and the harness's `readFile` returns ENOENT if the parent
        // doesn't exist. Pre-create the planning dir before the AI
        // session starts.
        if (opts.outputFilePath !== undefined && opts.outputFilePath !== '') {
          await mkdir(dirname(opts.outputFilePath), { recursive: true });
        }

        const result = await useCase.execute({
          sprint: input.sprint,
          existingTasks: input.existingTasks,
          cwd: input.cwd,
          promptFilePath: String(input.promptFilePath),
          ...(opts.interactive === true ? { interactive: true } : {}),
          ...(opts.outputFilePath !== undefined ? { outputFilePath: opts.outputFilePath } : {}),
          ...(opts.runInTerminal !== undefined ? { runInTerminal: opts.runInTerminal } : {}),
          ...(input.additionalRepoPaths.length > 0 ? { additionalRepoPaths: input.additionalRepoPaths } : {}),
          ...(input.sessionMdPath !== undefined ? { sessionMdPath: input.sessionMdPath } : {}),
        });
        if (!result.ok) return Result.error(result.error);
        return Result.ok(result.value.tasks);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('plan-tasks: ctx.sprint must be loaded');
      if (!ctx.promptFilePath) throw new Error('plan-tasks: ctx.promptFilePath must be set by render-prompt-to-file');
      if (!ctx.cwd) throw new Error('plan-tasks: ctx.cwd must be set by build-planning-folder');
      // The sandbox workspace is the canonical cwd; affected repos are
      // exposed via `--add-dir` (Claude) or mirrored inside the
      // sandbox (Copilot) — the workspace leaf populates `planAddDirs`
      // accordingly.
      return {
        sprint: ctx.sprint,
        existingTasks: ctx.tasks ?? [],
        cwd: ctx.cwd,
        additionalRepoPaths: ctx.planAddDirs ?? [],
        promptFilePath: ctx.promptFilePath,
        ...(ctx.planningSessionMdPath !== undefined ? { sessionMdPath: ctx.planningSessionMdPath } : {}),
      };
    },
    output: (ctx, tasks) => ({ ...ctx, tasks }),
  });
}

/**
 * `persist-repo-selection` — load the sprint's project, pick which of its
 * repos this sprint touches, and persist the selection on the sprint
 * aggregate. Single-repo projects skip the prompt entirely; multi-repo
 * projects render a checkbox UI with all repos pre-selected by default.
 *
 * The leaf reads `ctx.sprint` (loaded above), looks up the project via
 * `projectRepo.findByName(sprint.projectName)`, calls
 * `sprint.setAffectedRepositories(...)`, and writes the updated sprint
 * back through `sprintRepo.save`. The mutated sprint is also threaded
 * onto `ctx.sprint` so downstream leaves (`build-plan-workspace`,
 * `plan-tasks`) see the new `affectedRepositories` without re-loading.
 */
function persistRepoSelectionLeaf(
  deps: Pick<ChainSharedDeps, 'sprintRepo' | 'projectRepo' | 'prompt' | 'logger'>
): Element<PlanCtx> {
  return new Leaf<PlanCtx, { readonly sprint: Sprint }, Sprint>('persist-repo-selection', {
    useCase: {
      async execute(input): Promise<Result<Sprint, DomainError>> {
        const projectResult = await deps.projectRepo.findByName(input.sprint.projectName);
        if (!projectResult.ok) return Result.error(projectResult.error);
        const project = projectResult.value;

        const selected = await pickAffectedRepos(project, input.sprint, deps);
        if (!selected.ok) return Result.error(selected.error);

        const updated = input.sprint.setAffectedRepositories(selected.value);
        if (!updated.ok) return Result.error(updated.error);

        const saved = await deps.sprintRepo.save(updated.value);
        if (!saved.ok) return Result.error(saved.error);

        return Result.ok(updated.value);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('persist-repo-selection: ctx.sprint must be loaded first');
      return { sprint: ctx.sprint };
    },
    output: (ctx, sprint) => ({ ...ctx, sprint }),
  });
}

/**
 * Pick repos for the sprint. Single-repo projects skip the prompt
 * (the choice is forced); multi-repo projects render a checkbox with
 * the previous selection (if any) pre-checked, falling back to ALL
 * repos by default.
 */
async function pickAffectedRepos(
  project: Project,
  sprint: Sprint,
  deps: Pick<ChainSharedDeps, 'prompt' | 'logger'>
): Promise<Result<readonly AbsolutePath[], InvalidStateError>> {
  if (project.repositories.length === 0) {
    return Result.error(
      new InvalidStateError({
        entity: 'project',
        currentState: 'no-repositories',
        attemptedAction: 'plan',
        message: `project '${String(project.name)}' has no repositories — cannot plan`,
      })
    );
  }

  if (project.repositories.length === 1) {
    const only = project.repositories[0];
    if (only === undefined) throw new Error('unreachable: length-check above');
    return Result.ok([only.path]);
  }

  const previousSelection = new Set(sprint.affectedRepositories.map((p) => String(p)));
  const choices = project.repositories.map((r) => ({
    label: `${r.name} — ${String(r.path)}`,
    value: String(r.path),
  }));
  const defaults = project.repositories
    .map((r) => String(r.path))
    .filter((p) => previousSelection.size === 0 || previousSelection.has(p));

  const selectedStrings = await deps.prompt.checkbox<string>({
    message: 'Select repositories to include in this planning session',
    choices,
    defaults,
  });

  if (selectedStrings.length === 0) {
    deps.logger.info('plan: user selected no repositories');
    return Result.error(
      new InvalidStateError({
        entity: 'sprint',
        currentState: 'no-repos-selected',
        attemptedAction: 'plan',
        message: 'at least one repository must be selected to plan',
      })
    );
  }

  const parsed: AbsolutePath[] = [];
  for (const s of selectedStrings) {
    const known = project.repositories.find((r) => String(r.path) === s);
    if (known === undefined) {
      return Result.error(
        new InvalidStateError({
          entity: 'project',
          currentState: 'unknown-repo-path',
          attemptedAction: 'plan',
          message: `selected repo '${s}' not found on project '${String(project.name)}'`,
        })
      );
    }
    parsed.push(known.path);
  }

  return Result.ok(parsed);
}

/**
 * `snapshot-existing-tasks` — when re-planning a sprint that already has
 * tasks on disk, copy the canonical `<sprintDir>/tasks.json` to
 * `<sprintDir>/planning/tasks-snapshot-<ISO>.json` so the prior plan
 * survives even when the AI replaces it. No-op on first plan (no
 * canonical file exists yet) and on read errors (snapshotting is
 * best-effort observability — do not block the chain).
 */
function snapshotExistingTasksLeaf(deps: Pick<ChainSharedDeps, 'logger'>): Element<PlanCtx> {
  return new Leaf<PlanCtx, { readonly sprintId: SprintId }, void>('snapshot-existing-tasks', {
    useCase: {
      async execute(input) {
        const storage = (await import('@src/integration/persistence/storage-paths.ts')).resolveStoragePaths();
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const canonical = storage.tasksFile(input.sprintId);
        const planning = storage.planningDir(input.sprintId);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const snapshot = path.join(planning, `tasks-snapshot-${stamp}.json`);
        try {
          const body = await fs.readFile(canonical, 'utf-8');
          await fs.mkdir(planning, { recursive: true });
          await fs.writeFile(snapshot, body, { encoding: 'utf-8', mode: 0o600 });
          deps.logger.info('plan: snapshotted existing tasks before replan', { snapshot });
        } catch {
          // No canonical file (first plan) or read error — best-effort, skip.
        }
        return Result.ok(undefined);
      },
    },
    input: (ctx) => ({ sprintId: ctx.sprintId }),
    output: (ctx) => ctx,
  });
}

function assertAllTicketsApprovedLeaf(): Element<PlanCtx> {
  return new Leaf<PlanCtx, { readonly sprint: Sprint }, void>('assert-all-tickets-approved', {
    useCase: {
      async execute(input) {
        if (input.sprint.tickets.length === 0 || !input.sprint.hasApprovedAllTickets()) {
          return Promise.resolve(
            Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: 'tickets-not-approved',
                attemptedAction: 'plan',
                message: 'plan requires every ticket to be approved (run sprint refine first)',
              })
            )
          );
        }
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('assert-all-tickets-approved: ctx.sprint must be loaded first');
      return { sprint: ctx.sprint };
    },
    output: (ctx) => ctx,
  });
}
