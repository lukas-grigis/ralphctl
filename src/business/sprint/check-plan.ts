import { Result } from '@src/domain/result.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { TodoTask, VerificationCriterion } from '@src/domain/entity/task.ts';
import { renderTaskGraphIssue, validateTaskGraph } from '@src/domain/entity/task-graph.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/**
 * Deterministic, zero-token plan critic. Reads the planner's resolved task list and folds every
 * problem it can prove offline into a {@link PlanCheckReport} the human approval gate renders
 * before deciding. Advisory by design — no finding blocks the chain; the operator stays the
 * approver, and a headless run (no reviewer wired) logs the findings and auto-accepts.
 *
 * Two tiers of check:
 *
 *  - `error` — structural faults the plan parser already rejects today
 *    (`parseTaskList` → `scheduleIntoWaves` → `validateTaskGraph`, plus the `TaskImportSpec`
 *    schema and the `createTask` invariants). Re-asserted here as cheap defence-in-depth so a
 *    future non-parser producer (replan, an AI critic rung, a hand-edited `tasks.json`) cannot
 *    slip a malformed plan past the gate.
 *  - `warning` — quality faults nothing else catches: a copied prompt placeholder as a check
 *    command, prose masquerading as a shell line, a multi-line command, duplicate criterion
 *    ids, or an all-manual task on a repo that demonstrably exposes a runnable check.
 *
 * A note on "the sprint's repositories": {@link import('@src/domain/entity/sprint.ts').Sprint}
 * carries tickets + `projectId` only, and `SprintExecution` carries no repo set — the sprint's
 * repositories ARE its project's {@link Project.repositories}, which is what this module checks
 * `task.repositoryId` against.
 *
 * Pure — no I/O, no clock, no logging. The caller (the `check-plan` leaf) does the logging.
 */

/** Structured location + reason for one plan-critic finding. @public */
export type PlanCheckFinding =
  | { readonly kind: 'task-graph'; readonly detail: string }
  | {
      readonly kind: 'unknown-repository';
      readonly detail: string;
      readonly taskOrder: number;
      readonly taskName: string;
    }
  | { readonly kind: 'no-criteria'; readonly detail: string; readonly taskOrder: number; readonly taskName: string }
  | {
      readonly kind: 'no-auto-criterion';
      readonly detail: string;
      readonly taskOrder: number;
      readonly taskName: string;
    }
  | {
      readonly kind: 'duplicate-criterion-id';
      readonly detail: string;
      readonly taskOrder: number;
      readonly taskName: string;
      readonly criterionId: string;
    }
  | {
      readonly kind: 'auto-criterion-missing-command';
      readonly detail: string;
      readonly taskOrder: number;
      readonly taskName: string;
      readonly criterionId: string;
    }
  | {
      readonly kind: 'placeholder-command';
      readonly detail: string;
      readonly taskOrder: number;
      readonly taskName: string;
      readonly criterionId: string;
      readonly command: string;
    }
  | {
      readonly kind: 'prose-command';
      readonly detail: string;
      readonly taskOrder: number;
      readonly taskName: string;
      readonly criterionId: string;
      readonly command: string;
    }
  | {
      readonly kind: 'multi-line-command';
      readonly detail: string;
      readonly taskOrder: number;
      readonly taskName: string;
      readonly criterionId: string;
      readonly command: string;
    };

/** @public */
export type PlanCheckFindingKind = PlanCheckFinding['kind'];

/** @public */
export type PlanCheckSeverity = 'error' | 'warning';

/**
 * Severity is a property of the KIND, never of the individual finding — so it is declared once
 * here rather than duplicated onto every constructed finding.
 *
 * @public
 */
export const SEVERITY_BY_KIND: Readonly<Record<PlanCheckFindingKind, PlanCheckSeverity>> = {
  'task-graph': 'error',
  'unknown-repository': 'error',
  'no-criteria': 'error',
  'auto-criterion-missing-command': 'error',
  'placeholder-command': 'warning',
  'prose-command': 'warning',
  'multi-line-command': 'warning',
  'duplicate-criterion-id': 'warning',
  'no-auto-criterion': 'warning',
};

/** @public */
export const severityOfFinding = (finding: PlanCheckFinding): PlanCheckSeverity => SEVERITY_BY_KIND[finding.kind];

export interface PlanCheckReport {
  /** Deterministic order: graph fault first, then tasks by `order` ASC, then criteria in array order. */
  readonly findings: readonly PlanCheckFinding[];
  readonly errorCount: number;
  readonly warningCount: number;
}

export interface CheckPlanProps {
  readonly project: Project;
  readonly tasks: readonly TodoTask[];
}

/** An angle-bracket placeholder — the shape the plan template's own example criteria use. */
const ANGLE_PLACEHOLDER = /<[^>\n]{1,80}>/;
/** Whole-word placeholder tokens a planner leaves behind when it does not know the command. */
const TOKEN_PLACEHOLDER = /\b(?:TODO|TBD|FIXME|XXX)\b/;
/** Literal or typographic ellipsis — an elided command is not runnable. */
const ELLIPSIS = /\.\.\.|…/;
/** Characters a real argv[0] can be built from. Anything else means the "command" is prose. */
const SHELL_HEAD = /^[A-Za-z0-9_@./+-]+$/;
/**
 * Sentence punctuation directly after a letter. Deliberately does NOT match `git add .` /
 * `docker build .`, where a space precedes the dot.
 */
const SENTENCE_TAIL = /[A-Za-z][.?]$/;

const isPlaceholderCommand = (command: string): boolean =>
  ANGLE_PLACEHOLDER.test(command) || TOKEN_PLACEHOLDER.test(command) || ELLIPSIS.test(command);

const isProseCommand = (command: string): boolean => {
  const head = command.split(/\s+/)[0] ?? '';
  return !SHELL_HEAD.test(head) || SENTENCE_TAIL.test(command);
};

const isMultiLineCommand = (command: string): boolean => command.includes('\n') || command.includes('\r');

/**
 * Does the repository demonstrably expose a runnable check? Structured `verifyGates` win over the
 * legacy opaque `verifyScript` (see {@link Repository.verifyGates}), but either is enough to make
 * "this task has no `auto` criterion" a real gap rather than noise on an unconfigured repo.
 */
const exposesCheckCommand = (repo: Repository | undefined): boolean =>
  repo !== undefined && (repo.verifyScript !== undefined || (repo.verifyGates?.length ?? 0) > 0);

/** Task-level checks: repository resolution and criteria coverage. */
const checkTaskShape = (task: TodoTask, repo: Repository | undefined): readonly PlanCheckFinding[] => {
  const at = { taskOrder: task.order, taskName: task.name };
  const findings: PlanCheckFinding[] = [];

  if (repo === undefined) {
    findings.push({
      ...at,
      kind: 'unknown-repository',
      detail: `references repository '${String(task.repositoryId)}', which is not one of the project's repositories`,
    });
  }

  if (task.verificationCriteria.length === 0) {
    findings.push({ ...at, kind: 'no-criteria', detail: 'has no verification criteria — nothing defines "done"' });
    return findings;
  }

  const autoCount = task.verificationCriteria.filter((c) => c.check === 'auto').length;
  if (autoCount === 0 && exposesCheckCommand(repo)) {
    findings.push({
      ...at,
      kind: 'no-auto-criterion',
      detail:
        'has only manual criteria while its repository exposes a check command — add at least one `auto` criterion',
    });
  }

  return findings;
};

/**
 * Command-quality checks for a single `auto` criterion. A placeholder command is reported as
 * exactly that and suppresses the prose check — the placeholder IS the explanation, and firing
 * both would double-report one fault. The multi-line check is independent: a command may be both
 * elided and wrapped.
 */
const checkAutoCommand = (
  at: { readonly taskOrder: number; readonly taskName: string; readonly criterionId: string },
  command: string
): readonly PlanCheckFinding[] => {
  const findings: PlanCheckFinding[] = [];
  const where = { ...at, command };

  if (isPlaceholderCommand(command)) {
    findings.push({
      ...where,
      kind: 'placeholder-command',
      detail: `command still carries a placeholder: \`${command}\``,
    });
  } else if (isProseCommand(command)) {
    findings.push({
      ...where,
      kind: 'prose-command',
      detail: `command reads as prose rather than a shell line: \`${command}\``,
    });
  }

  if (isMultiLineCommand(command)) {
    findings.push({
      ...where,
      kind: 'multi-line-command',
      detail: 'command spans multiple lines — criteria render one command per line downstream',
    });
  }

  return findings;
};

/** Per-criterion checks: id uniqueness within the task, then `auto` command quality. */
const checkCriteria = (task: TodoTask): readonly PlanCheckFinding[] => {
  const findings: PlanCheckFinding[] = [];
  const seen = new Set<string>();

  for (const criterion of task.verificationCriteria) {
    const at = { taskOrder: task.order, taskName: task.name, criterionId: criterion.id };

    if (seen.has(criterion.id)) {
      findings.push({
        ...at,
        kind: 'duplicate-criterion-id',
        detail: `criterion id '${criterion.id}' is used more than once — per-criterion verdicts are keyed by id, so duplicates collapse into one slot`,
      });
    }
    seen.add(criterion.id);

    findings.push(...checkOneCriterion(at, criterion));
  }

  return findings;
};

const checkOneCriterion = (
  at: { readonly taskOrder: number; readonly taskName: string; readonly criterionId: string },
  criterion: VerificationCriterion
): readonly PlanCheckFinding[] => {
  if (criterion.check !== 'auto') return [];
  const command = (criterion.command ?? '').trim();
  if (command.length === 0) {
    return [
      {
        ...at,
        kind: 'auto-criterion-missing-command',
        detail: 'is an `auto` criterion with no command — the evaluator has nothing to run',
      },
    ];
  }
  return checkAutoCommand(at, command);
};

/**
 * Fold every deterministic problem in the proposed plan into one report.
 *
 * Infallible: the `Result` envelope is kept because every business operation returns one (and
 * because `LeafUseCase.execute` requires it), but there is no error path today — a malformed
 * plan produces `error`-tier FINDINGS, never a `Result.error`. Callers may treat the envelope as
 * always-ok without losing information.
 *
 * @public
 */
export const checkPlanUseCase = (props: CheckPlanProps): Result<PlanCheckReport, DomainError> => {
  const findings: PlanCheckFinding[] = [];

  const graph = validateTaskGraph(props.tasks);
  if (!graph.ok) findings.push({ kind: 'task-graph', detail: renderTaskGraphIssue(graph.error) });

  const reposById = new Map<RepositoryId, Repository>(props.project.repositories.map((r) => [r.id, r]));
  // Sort is stable in V8, so equal `order` values keep their declared sequence.
  for (const task of [...props.tasks].sort((a, b) => a.order - b.order)) {
    findings.push(...checkTaskShape(task, reposById.get(task.repositoryId)));
    findings.push(...checkCriteria(task));
  }

  return Result.ok({
    findings,
    errorCount: findings.filter((f) => SEVERITY_BY_KIND[f.kind] === 'error').length,
    warningCount: findings.filter((f) => SEVERITY_BY_KIND[f.kind] === 'warning').length,
  });
};

/**
 * Render one finding as a single human-readable line, mirroring the `renderTaskGraphIssue`
 * precedent — the phrasing lives next to the shape it describes so producers (the `check-plan`
 * leaf's log) and consumers (the approval prompt) always say the same thing.
 *
 * @public
 */
export const renderPlanCheckFinding = (finding: PlanCheckFinding): string =>
  `${SEVERITY_BY_KIND[finding.kind]}: ${locationOf(finding)} — ${finding.detail}`;

const locationOf = (finding: PlanCheckFinding): string => {
  if (!('taskOrder' in finding)) return 'plan graph';
  const criterion = 'criterionId' in finding ? ` [${finding.criterionId}]` : '';
  return `task ${String(finding.taskOrder)} '${finding.taskName}'${criterion}`;
};
