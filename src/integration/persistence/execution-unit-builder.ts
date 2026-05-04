/**
 * `buildExecutionUnit` / `refreshExecutionUnit` — materialise a per-task
 * evaluation sandbox for the evaluator session.
 *
 * Layout: `<sprintDir>/execution/<id>-<slug>/`
 *
 *   Static (written once by `buildExecutionUnit`, untouched by `refresh`):
 *     - `CLAUDE.md` or `.github/copilot-instructions.md` (context file)
 *     - `requirements/<ticket-id>.md` — per-ticket requirements input
 *     - `dimensions.md` — grading rubric (floor + extra dimensions)
 *
 *   Volatile (overwritten by both `buildExecutionUnit` and `refreshExecutionUnit`):
 *     - `task.md` — the single task under review
 *     - `tasks.md` — full task plan as markdown
 *     - `tasks.json` — machine-readable task list
 *     - `project-context.md` — copy of the target repo's context file
 *     - `evaluations/<task-id>.md` — prior evaluation critiques
 *
 *   Copilot only (mirrored at build time):
 *     - `repo/` — mirror of `task.projectPath`
 *
 * Note: `evaluation.md` (the live evaluator output sink) is NOT written
 * here — `ProviderAiSessionAdapter` writes it per-round.
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { AiProvider } from '@src/business/ports/ai-session-port.ts';
import type { ExecutionUnitPaths } from '@src/business/ports/session-folder-builder-port.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';
import type { StoragePaths } from '@src/integration/persistence/storage-paths.ts';
import { unitSlug } from '@src/integration/persistence/unit-slug.ts';
import {
  copyFileSafe,
  ensureDirSafe,
  mirrorRepo,
  writeContextFile,
  writeFileSafe,
} from '@src/integration/persistence/session-folder-helpers.ts';

// ──────────────────────── evaluation rubric ──────────────────────────────

/**
 * Canonical floor-dimension descriptions for the evaluator rubric. Mirror
 * the prose in `src/integration/ai/prompts/templates/task-evaluation.md`
 * — duplicated here intentionally so the unit's contract pack is
 * self-contained even when the evaluator template evolves.
 */
const FLOOR_DIMENSIONS: readonly { name: string; description: string }[] = [
  {
    name: 'Correctness',
    description:
      'Does the implementation do what the specification says? Check for: logical errors, off-by-one, race conditions, type issues; behavior matches each verification criterion (grade each one explicitly); edge cases handled where specified.',
  },
  {
    name: 'Completeness',
    description:
      'Is the full specification implemented? Check for: every verification criterion satisfied (not just most); no steps skipped or partially implemented; no TODO/FIXME/HACK markers left behind that indicate unfinished work; partially-implemented criteria or half-finished tests. Note: the harness commits the task after this evaluation completes, so uncommitted changes from the generator are expected during this review — do not penalise them. Look instead for WIP markers in code (TODO/FIXME/HACK), partially-implemented criteria, half-finished tests.',
  },
  {
    name: 'Safety',
    description:
      'Are there security or reliability issues? Check for: injection vulnerabilities (SQL, command, XSS); validation gaps on external input; exposed secrets, hardcoded credentials; unsafe error handling that leaks internals.',
  },
  {
    name: 'Consistency',
    description:
      'Does the implementation fit the codebase? Check for: follows existing patterns and conventions (naming, structure, error handling); uses existing utilities instead of reinventing them; no unnecessary changes outside the task scope (spec drift); test patterns match the project existing test style.',
  },
];

// ─────────────────────────── renderers ───────────────────────────────────

/**
 * Render a per-ticket requirements file for evaluator units. Concatenates
 * the raw ticket fields under headings followed by the refined
 * requirements blob.
 */
function renderRequirementsInput(ticket: Ticket): string {
  const lines: string[] = [`# ${ticket.title}`, '', `**Ticket id:** \`${ticket.id}\``];
  if (ticket.link !== undefined) lines.push(`**Link:** ${ticket.link}`);
  lines.push('');
  if (ticket.description !== undefined && ticket.description.length > 0) {
    lines.push('## Description', '', ticket.description, '');
  }
  if (ticket.requirements !== undefined && ticket.requirements.length > 0) {
    lines.push('## Refined requirements', '', ticket.requirements, '');
  } else {
    lines.push('## Refined requirements', '', '_No refined requirements approved yet._', '');
  }
  return lines.join('\n');
}

/**
 * Render `task.md` — the single task under review. Carries name, status,
 * description, steps, verification criteria, and dependency list.
 */
function renderTaskInput(task: Task): string {
  const lines: string[] = [
    `# ${task.name}`,
    '',
    `- **Task id:** \`${task.id}\``,
    `- **Status:** ${task.status}`,
    `- **Order:** ${String(task.order)}`,
    `- **Project path:** \`${task.projectPath}\``,
  ];
  if (task.ticketId !== undefined) lines.push(`- **Ticket:** \`${task.ticketId}\``);
  if (task.blockedBy.length > 0) lines.push(`- **Blocked by:** ${task.blockedBy.map((id) => `\`${id}\``).join(', ')}`);
  lines.push('');
  if (task.description !== undefined && task.description.length > 0) {
    lines.push('## Description', '', task.description, '');
  }
  if (task.steps.length > 0) {
    lines.push('## Steps', '');
    for (const step of task.steps) lines.push(`- ${step}`);
    lines.push('');
  }
  if (task.verificationCriteria.length > 0) {
    lines.push('## Verification criteria', '');
    for (const c of task.verificationCriteria) lines.push(`- ${c}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Render `tasks.md` — the full task plan as one markdown section per
 * task, sorted by `order`.
 */
function renderTasksList(tasks: readonly Task[]): string {
  const ordered = [...tasks].sort((a, b) => a.order - b.order);
  const lines: string[] = ['# Task plan', ''];
  for (const t of ordered) {
    lines.push(`## ${String(t.order)}. ${t.name}`);
    lines.push('');
    lines.push(`- **Task id:** \`${t.id}\``);
    lines.push(`- **Status:** ${t.status}`);
    if (t.blockedBy.length > 0) lines.push(`- **Blocked by:** ${t.blockedBy.map((id) => `\`${id}\``).join(', ')}`);
    lines.push(`- **Project path:** \`${t.projectPath}\``);
    lines.push('');
    if (t.description !== undefined && t.description.length > 0) {
      lines.push('### Description', '', t.description, '');
    }
    if (t.steps.length > 0) {
      lines.push('### Steps', '');
      for (const step of t.steps) lines.push(`- ${step}`);
      lines.push('');
    }
    if (t.verificationCriteria.length > 0) {
      lines.push('### Verification criteria', '');
      for (const c of t.verificationCriteria) lines.push(`- ${c}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * Render `dimensions.md` — the four floor dimensions plus any task
 * `extraDimensions` emitted by the planner.
 */
function renderDimensions(task: Task): string {
  const lines: string[] = [
    '# Evaluation dimensions',
    '',
    'Every task is graded on the four floor dimensions. Some tasks carry extra dimensions emitted by the planner — those are graded on top of the floor.',
    '',
  ];
  let n = 1;
  for (const d of FLOOR_DIMENSIONS) {
    lines.push(`## Dimension ${String(n)} — ${d.name} (floor)`);
    lines.push('');
    lines.push(d.description);
    lines.push('');
    n += 1;
  }
  if (task.extraDimensions !== undefined) {
    for (const name of task.extraDimensions) {
      lines.push(`## Dimension ${String(n)} — ${name} (extra)`);
      lines.push('');
      lines.push('_Defined per-task by the planner — refer to the prompt for the grading rubric._');
      lines.push('');
      n += 1;
    }
  }
  return lines.join('\n');
}

/**
 * Read the target repo's project-context file and surface it inside the
 * unit folder as `project-context.md`.
 */
async function readProjectContext(repoPath: AbsolutePath, provider: AiProvider): Promise<string> {
  const target =
    provider === 'claude' ? join(repoPath, 'CLAUDE.md') : join(repoPath, '.github', 'copilot-instructions.md');
  try {
    const body = await readFile(target, 'utf-8');
    return [`<!-- copied from ${target} -->`, '', body].join('\n');
  } catch {
    return [
      `<!-- expected ${target} not present -->`,
      '',
      '# Project context',
      '',
      '_(no project context file present in this repo)_',
      '',
    ].join('\n');
  }
}

/**
 * Stable, JSON-friendly snapshot of a task list.
 */
function serialiseTasks(tasks: readonly Task[]): readonly Record<string, unknown>[] {
  return [...tasks]
    .sort((a, b) => a.order - b.order)
    .map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      steps: t.steps,
      verificationCriteria: t.verificationCriteria,
      status: t.status,
      order: t.order,
      ticketId: t.ticketId,
      blockedBy: t.blockedBy,
      projectPath: t.projectPath,
      extraDimensions: t.extraDimensions,
    }));
}

// ────────────────────────── volatile writer ───────────────────────────────

/**
 * Write (or overwrite) the volatile per-task files inside an execution unit
 * folder. Called by both `buildExecutionUnit` (initial build) and
 * `refreshExecutionUnit` (between evaluator rounds).
 */
export async function writeExecutionVolatile(args: {
  root: AbsolutePath;
  sprint: Sprint;
  tasks: readonly Task[];
  task: Task;
  aiProvider: AiProvider;
  priorEvaluations: ReadonlyMap<TaskId, string>;
}): Promise<Result<void, StorageError>> {
  const taskMd = await writeFileSafe(join(args.root, 'task.md'), renderTaskInput(args.task));
  if (!taskMd.ok) return Result.error(taskMd.error);

  const tasksMd = await writeFileSafe(join(args.root, 'tasks.md'), renderTasksList(args.tasks));
  if (!tasksMd.ok) return Result.error(tasksMd.error);

  const tasksJson = await writeFileSafe(
    join(args.root, 'tasks.json'),
    JSON.stringify(serialiseTasks(args.tasks), null, 2)
  );
  if (!tasksJson.ok) return Result.error(tasksJson.error);

  const projectContext = await readProjectContext(args.task.projectPath, args.aiProvider);
  const projectCtxFile = await writeFileSafe(join(args.root, 'project-context.md'), projectContext);
  if (!projectCtxFile.ok) return Result.error(projectCtxFile.error);

  const evaluationsDir = join(args.root, 'evaluations');
  try {
    await rm(evaluationsDir, { recursive: true, force: true });
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to clear ${evaluationsDir}: ${err instanceof Error ? err.message : String(err)}`,
        path: evaluationsDir,
        cause: err,
      })
    );
  }
  const ensureEvals = await ensureDirSafe(evaluationsDir);
  if (!ensureEvals.ok) return Result.error(ensureEvals.error);
  for (const [taskId, body] of args.priorEvaluations) {
    const w = await writeFileSafe(join(evaluationsDir, `${taskId}.md`), body);
    if (!w.ok) return Result.error(w.error);
  }
  return Result.ok();
}

// ─────────────────────────── public API ──────────────────────────────────

export async function buildExecutionUnit(
  storage: StoragePaths,
  input: {
    readonly sprint: Sprint;
    readonly tasks: readonly Task[];
    readonly task: Task;
    readonly aiProvider: AiProvider;
    readonly priorEvaluations: ReadonlyMap<TaskId, string>;
    /** Optional warn sink for non-fatal issues (e.g. missing done-criteria.md). */
    readonly onWarn?: (message: string) => void;
  }
): Promise<Result<ExecutionUnitPaths, DomainError>> {
  const slug = unitSlug(String(input.task.id), input.task.name);
  const root = storage.executionUnitDir(input.sprint.id, slug);
  const requirementsDir = AbsolutePath.trustString(join(root, 'requirements'));

  const ensure = await ensureDirSafe(requirementsDir);
  if (!ensure.ok) return Result.error(ensure.error);

  const ctx = await writeContextFile({
    root,
    sprint: input.sprint,
    provider: input.aiProvider,
    phase: 'evaluate',
    affectedRepos: [input.task.projectPath],
  });
  if (!ctx.ok) return Result.error(ctx.error);

  // Static: per-ticket requirements + the dimensions rubric.
  for (const ticket of input.sprint.tickets) {
    const filePath = join(requirementsDir, `${ticket.id}.md`);
    const w = await writeFileSafe(filePath, renderRequirementsInput(ticket));
    if (!w.ok) return Result.error(w.error);
  }
  const dims = await writeFileSafe(join(root, 'dimensions.md'), renderDimensions(input.task));
  if (!dims.ok) return Result.error(dims.error);

  // Static: done-criteria.md — copy from <sprintDir>/done-criteria.md.
  // When the file is absent (legacy sprint with tasks but no criteria file)
  // log a warn and proceed — do NOT fail the workspace build.
  const sprintCriteriaPath = String(storage.doneCriteriaFile(input.sprint.id));
  const unitCriteriaPath = join(root, 'done-criteria.md');
  const copied = await copyFileSafe(sprintCriteriaPath, unitCriteriaPath);
  if (!copied.ok) {
    const msg = `build-execution-unit: done-criteria.md not found for sprint ${String(input.sprint.id)} — evaluator will grade without per-task criteria reference`;
    if (input.onWarn) {
      input.onWarn(msg);
    }
  }

  // Volatile: task.md, tasks.md, tasks.json, project-context.md, evaluations/.
  const volatile = await writeExecutionVolatile({
    root,
    sprint: input.sprint,
    tasks: input.tasks,
    task: input.task,
    aiProvider: input.aiProvider,
    priorEvaluations: input.priorEvaluations,
  });
  if (!volatile.ok) return Result.error(volatile.error);

  let addDirs: readonly AbsolutePath[];
  let sessionCwd: AbsolutePath;
  if (input.aiProvider === 'copilot') {
    const repoMirror = join(root, 'repo');
    const m = await mirrorRepo(input.task.projectPath, repoMirror);
    if (!m.ok) return Result.error(m.error);
    addDirs = [];
    sessionCwd = root;
  } else {
    addDirs = [root];
    sessionCwd = input.task.projectPath;
  }

  return Result.ok({
    root,
    addDirs,
    sessionCwd,
    evaluationMdPath: AbsolutePath.trustString(join(root, 'evaluation.md')),
  });
}

export async function refreshExecutionUnit(
  storage: StoragePaths,
  input: {
    readonly sprint: Sprint;
    readonly tasks: readonly Task[];
    readonly task: Task;
    readonly aiProvider: AiProvider;
    readonly priorEvaluations: ReadonlyMap<TaskId, string>;
  }
): Promise<Result<void, DomainError>> {
  const slug = unitSlug(String(input.task.id), input.task.name);
  const root = storage.executionUnitDir(input.sprint.id, slug);
  return writeExecutionVolatile({
    root,
    sprint: input.sprint,
    tasks: input.tasks,
    task: input.task,
    aiProvider: input.aiProvider,
    priorEvaluations: input.priorEvaluations,
  });
}
