import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TaskStatus } from '@src/domain/entity/task.ts';
import { neutralizeProseHeadings, sanitizeInline } from '@src/business/sprint/journal-sanitize.ts';

/**
 * Render the DERIVED sprint-state header band for `<sprintDir>/progress.md` — the always-kept block
 * that rides before the first `## Task: ` section. Unlike the attempt sections (append-only, partly
 * AI prose), this block is regenerated in place on every per-attempt append from CANONICAL data
 * (`sprint.json` / `tasks.json` / `execution.json`), so the inlined excerpt always opens with an
 * accurate, machine-derived snapshot of where the sprint stands. No AI prose — every value is a
 * projection of harness state.
 *
 * Subsumes the one-time creation header (`renderJournalSprintHeader`): it re-emits the same sprint
 * identity block (`# Sprint:` / id / created) and adds Status, Branch & PR, open Blockers, Stale
 * tasks, and a per-task status table whose `Passes` column is the k-of-N count of verification
 * criteria the harness has graded `passed` (k passed / N total criteria).
 *
 * Forgery-safe: task names and blocked reasons are AI-/planner-authored, so they are collapsed to a
 * single line and heading-neutralized — a `## Task:`-shaped name can never forge a section boundary
 * inside the header band. The block's own headings (`## Status` / `## Tasks` / …) never start with
 * the literal `## Task: ` delimiter, so the journal splitter is unaffected.
 *
 * Pure — no I/O.
 */

/** Per-task projection the header table + blocker/stale lists render from. */
export interface SprintStateTask {
  readonly name: string;
  readonly status: TaskStatus;
  /** Verification criteria the harness has graded `passed` — the `k` in the `Passes` column. */
  readonly criteriaPassed: number;
  /** Total verification criteria on the task — the `N` in the `Passes` column. */
  readonly criteriaTotal: number;
  /** Total attempts recorded for the task. */
  readonly attemptCount: number;
  /** Present only on a `blocked` task — the reason, surfaced under `## Blockers`. */
  readonly blockedReason?: string;
}

interface SprintStateHeaderInput {
  readonly sprintName: string;
  readonly sprintId: string;
  /** Sprint-creation timestamp — preserved across regenerations so the line stays stable. */
  readonly createdAt: IsoTimestamp;
  /** Sprint lifecycle state (`draft` / `planned` / `active` / `review` / `done`). */
  readonly status: string;
  readonly branch: string | null;
  readonly pullRequestUrl: string | null;
  readonly tasks: readonly SprintStateTask[];
}

const EM_DASH = '—';

/** One-line, heading-neutralized cell for an AI-/planner-authored string. */
const cell = (text: string): string => neutralizeProseHeadings(sanitizeInline(text));

/**
 * A task is STALE when work was started (`in_progress`, ≥1 attempt) but never settled — an
 * escalation retry mid-flight or an interrupted run. Surfaced so a re-entering session sees what is
 * stuck, not just what is blocked. `todo` tasks (never started) and terminal tasks are not stale.
 */
const isStale = (task: SprintStateTask): boolean => task.status === 'in_progress' && task.attemptCount > 0;

const orEmDash = (value: string | null): string => (value !== null && value.length > 0 ? value : EM_DASH);

/** Sprint identity block (`# Sprint:` / id / created). */
const renderIdentity = (input: SprintStateHeaderInput): string[] => [
  `# Sprint: ${cell(input.sprintName)}`,
  '',
  `- id: ${input.sprintId}`,
  `- created: ${String(input.createdAt)}`,
  '',
];

/** `## Status` block — derived lifecycle state, branch, PR. */
const renderStatus = (input: SprintStateHeaderInput): string[] => [
  '## Status',
  '',
  `- State: ${input.status}`,
  `- Branch: ${orEmDash(input.branch)}`,
  `- PR: ${orEmDash(input.pullRequestUrl)}`,
  '',
];

/** `## Blockers` block — one bullet per blocked task with its reason. Empty when none are blocked. */
const renderBlockers = (tasks: readonly SprintStateTask[]): string[] => {
  const blockers = tasks.filter((t) => t.status === 'blocked');
  if (blockers.length === 0) return [];
  const bullets = blockers.map((t) => {
    const reason = t.blockedReason !== undefined && t.blockedReason.trim().length > 0 ? cell(t.blockedReason) : EM_DASH;
    return `- ${cell(t.name)}: ${reason}`;
  });
  return ['## Blockers', '', ...bullets, ''];
};

/** `## Stale tasks` block — started-but-not-settled tasks. Empty when none are stale. */
const renderStale = (tasks: readonly SprintStateTask[]): string[] => {
  const stale = tasks.filter(isStale);
  if (stale.length === 0) return [];
  const bullets = stale.map(
    (t) => `- ${cell(t.name)} (${String(t.attemptCount)} attempt${t.attemptCount === 1 ? '' : 's'}, not settled)`
  );
  return ['## Stale tasks', '', ...bullets, ''];
};

/**
 * `k/N` criteria-passed cell for the `Passes` column, or an em-dash when the task declares no
 * verification criteria (nothing to count) — the graceful fallback before any verdict is folded.
 */
const passesCell = (task: SprintStateTask): string =>
  task.criteriaTotal === 0 ? EM_DASH : `${String(task.criteriaPassed)}/${String(task.criteriaTotal)}`;

/** `## Tasks` block — per-task status + k/N criteria-pass table, or a placeholder when none are planned. */
const renderTaskTable = (tasks: readonly SprintStateTask[]): string[] => {
  if (tasks.length === 0) return ['## Tasks', '', '_No tasks planned yet._', ''];
  const rows = tasks.map((t) => `| ${cell(t.name)} | ${t.status} | ${passesCell(t)} |`);
  return ['## Tasks', '', '| Task | Status | Passes |', '| --- | --- | --- |', ...rows, ''];
};

export const renderSprintStateHeader = (input: SprintStateHeaderInput): string =>
  [
    ...renderIdentity(input),
    ...renderStatus(input),
    ...renderBlockers(input.tasks),
    ...renderStale(input.tasks),
    ...renderTaskTable(input.tasks),
  ].join('\n');
