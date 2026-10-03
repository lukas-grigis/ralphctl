/** `ralphctl runs stats` — the harness outcome rollup, projected onto the CLI. */

import type { Command } from 'commander';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';
import { renderOutcomeStats } from '@src/application/ui/cli/commands/runs-stats-report.ts';
import { foldOutcomeStats, type SprintWithTasks } from '@src/business/runs/outcome-stats.ts';

interface StatsOpts {
  readonly json?: boolean;
  readonly since?: string;
  readonly sprint?: string;
  readonly project?: string;
}

/** The slice of the wired deps this command reads — all three ports are read-only here. */
type StatsDeps = Pick<AppDeps, 'sprintRepo' | 'taskRepo' | 'projectRepo'>;

type SinceResult = { readonly ok: true; readonly sinceMs: number | undefined } | { readonly ok: false };
type ScopeResult = { readonly ok: true; readonly sprints: readonly Sprint[] } | { readonly ok: false };

const SINCE_DESC =
  'ISO date — keep sprints whose latest lifecycle stamp (done, else review, else activated, else planned) is on or after it; never-planned drafts have no stamp and drop out';

/**
 * Register `runs stats` on the `runs` group: `ralphctl runs stats [--json] [--since <date>] [--sprint <id>]
 * [--project <id>]`.
 */
export const registerRunsStatsCommand = (runs: Command): void => {
  runs
    .command('stats')
    .description('summarise harness outcomes across sprints (outcome mix, first-pass rate, escalation efficacy)')
    .option('--json', 'print the raw rollup as JSON (stable ordering — diff two runs to compare settings)')
    .option('--since <date>', SINCE_DESC)
    .option('-s, --sprint <id>', 'restrict the rollup to a single sprint')
    .option('-p, --project <id>', "restrict the rollup to one project's sprints")
    .action(runStatsCommand);
};

const runStatsCommand = async (opts: StatsOpts): Promise<void> => {
  if (opts.sprint !== undefined && opts.project !== undefined) {
    fail('--sprint and --project are mutually exclusive — pass one, or neither to cover every sprint');
    return;
  }
  const since = parseSince(opts.since);
  if (!since.ok) return;

  const { deps } = await bootstrapCli();
  const scoped = await resolveScopedSprints(deps, opts);
  if (!scoped.ok) return;

  const inWindow = since.sinceMs === undefined ? scoped.sprints : scoped.sprints.filter(activeSince(since.sinceMs));

  // The fold is total — an empty scope yields a well-formed all-zero report — so `--json` stays
  // machine-parseable even when nothing matched. Only the human surface degrades to a one-liner.
  if (inWindow.length === 0 && opts.json !== true) {
    process.stdout.write(emptyNotice(opts));
    return;
  }

  const slices = await loadSlices(deps, inWindow);
  if (slices === undefined) return;

  const stats = foldOutcomeStats(slices);
  process.stdout.write(opts.json === true ? `${JSON.stringify(stats, null, 2)}\n` : renderOutcomeStats(stats));
};

/** `--since` accepts any `Date.parse`-able ISO form: `2026-01-31` or `2026-01-31T09:00:00Z`. */
const parseSince = (raw: string | undefined): SinceResult => {
  if (raw === undefined) return { ok: true, sinceMs: undefined };
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    fail(`--since must be an ISO date (e.g. 2026-01-31 or 2026-01-31T09:00:00Z) — got '${raw}'`);
    return { ok: false };
  }
  return { ok: true, sinceMs: parsed };
};

/** "Active since" = the sprint's LATEST lifecycle stamp is on or after the cutoff. */
const lastActivityMs = (sprint: Sprint): number | undefined => {
  const stamp = sprint.doneAt ?? sprint.reviewAt ?? sprint.activatedAt ?? sprint.plannedAt;
  if (stamp === null) return undefined;
  const parsed = Date.parse(String(stamp));
  return Number.isNaN(parsed) ? undefined : parsed;
};

const activeSince =
  (sinceMs: number) =>
  (sprint: Sprint): boolean => {
    const activity = lastActivityMs(sprint);
    return activity !== undefined && activity >= sinceMs;
  };

/** Resolve the sprint population. */
const resolveScopedSprints = async (deps: StatsDeps, opts: StatsOpts): Promise<ScopeResult> => {
  if (opts.sprint !== undefined) {
    const id = SprintId.parse(opts.sprint);
    if (!id.ok) {
      fail(`invalid sprint id: ${id.error.message}`);
      return { ok: false };
    }
    const found = await deps.sprintRepo.findById(id.value);
    if (!found.ok) {
      fail(found.error.message);
      return { ok: false };
    }
    return { ok: true, sprints: [found.value] };
  }

  const all = await deps.sprintRepo.list();
  if (!all.ok) {
    fail(all.error.message);
    return { ok: false };
  }
  if (opts.project === undefined) return { ok: true, sprints: all.value };

  const projectId = ProjectId.parse(opts.project);
  if (!projectId.ok) {
    fail(`invalid project id: ${projectId.error.message}`);
    return { ok: false };
  }
  const project = await deps.projectRepo.findById(projectId.value);
  if (!project.ok) {
    fail(project.error.message);
    return { ok: false };
  }
  return { ok: true, sprints: all.value.filter((sprint) => sprint.projectId === projectId.value) };
};

/** Pair every scoped sprint with its persisted task list. */
const loadSlices = async (
  deps: StatsDeps,
  sprints: readonly Sprint[]
): Promise<readonly SprintWithTasks[] | undefined> => {
  const reads = await Promise.all(
    sprints.map(async (sprint) => ({ sprint, tasks: await deps.taskRepo.findBySprintId(sprint.id) }))
  );
  const slices: SprintWithTasks[] = [];
  for (const { sprint, tasks } of reads) {
    if (!tasks.ok) {
      fail(`sprint ${String(sprint.id)}: ${tasks.error.message}`);
      return undefined;
    }
    slices.push({ sprint, tasks: tasks.value });
  }
  return slices;
};

const emptyNotice = (opts: StatsOpts): string => {
  const filtered = opts.since !== undefined || opts.sprint !== undefined || opts.project !== undefined;
  return filtered
    ? '(no sprints match this scope — widen or drop --since / --sprint / --project)\n'
    : '(no sprints yet — nothing to summarise)\n';
};
