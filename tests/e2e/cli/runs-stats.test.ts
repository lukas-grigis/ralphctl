import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activateSprint, planSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Result } from '@src/domain/result.ts';
import type { OutcomeStats } from '@src/business/runs/outcome-stats.ts';
import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import {
  FIXED_PROJECT_ID,
  isoTimestamp,
  makeApprovedTicket,
  makeDoneTask,
  makeDoneTaskWithWarning,
  makeDraftSprint,
  makeProject,
  makeTodoTask,
  projectId,
} from '@tests/fixtures/domain.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error(`fixture unwrap failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
};

const SECOND_PROJECT_ID = projectId('01900000-0000-7000-8000-0000000000aa');

interface SeedOpts {
  readonly name: string;
  /** Stamped as both `plannedAt` and `activatedAt` — the sprint's last-activity instant. */
  readonly activatedAt: string;
  readonly projectId?: ProjectId;
  readonly tasks: readonly Task[];
}

/** Persist an active sprint (with a controllable lifecycle stamp) plus its task list. */
const seedActiveSprint = async (cli: CliHome, opts: SeedOpts): Promise<Sprint> => {
  const at = isoTimestamp(opts.activatedAt);
  const draft = makeDraftSprint({
    name: opts.name,
    tickets: [makeApprovedTicket()],
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
  });
  const active = unwrap(activateSprint(unwrap(planSprint(draft, at)), at));
  await createFsSprintRepository({ root: cli.paths.dataRoot }).save(active);
  await createFsTaskRepository({ root: cli.paths.dataRoot }).saveAll(active.id, opts.tasks);
  return active;
};

/** A draft sprint carries no lifecycle stamp at all — the `--since` drop-out case. */
const seedDraftSprint = async (cli: CliHome, name: string, tasks: readonly Task[]): Promise<Sprint> => {
  const draft = makeDraftSprint({ name, tickets: [makeApprovedTicket()] });
  await createFsSprintRepository({ root: cli.paths.dataRoot }).save(draft);
  await createFsTaskRepository({ root: cli.paths.dataRoot }).saveAll(draft.id, tasks);
  return draft;
};

const blockedTask = (name: string): Task => unwrap(markTaskBlocked(makeTodoTask({ name }), 'wedged', 'own'));

/** A done task carrying the escalation stamps the fold reconstructs rungs from. */
const escalatedDoneTask = (name: string): Task => ({
  ...makeDoneTask({ name }),
  escalatedFromModel: 'small-model',
  escalatedToModel: 'big-model',
  bestOfNGranted: true,
});

const parseStats = (stdout: string): OutcomeStats => JSON.parse(stdout) as OutcomeStats;

describe('ralphctl runs stats', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  describe('default scope (every sprint)', () => {
    it('rolls up outcome mix, first-pass, plateau, escalation and criteria across all sprints', async () => {
      await seedActiveSprint(cli, {
        name: 'alpha sprint',
        activatedAt: '2026-05-08T10:00:00.000Z',
        tasks: [makeDoneTask({ name: 'clean' }), makeDoneTaskWithWarning({ name: 'warned' })],
      });
      await seedActiveSprint(cli, {
        name: 'beta sprint',
        activatedAt: '2026-07-08T10:00:00.000Z',
        tasks: [escalatedDoneTask('escalated'), blockedTask('wedged'), makeTodoTask({ name: 'pending' })],
      });

      const result = await runCliCaptured(cli, ['runs', 'stats']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Harness outcomes — 2 sprints · 5 tasks');
      expect(result.stdout).toContain('Outcome mix');
      expect(result.stdout).toContain('(clean 2 · with warning 1)');
      expect(result.stdout).toContain('first pass');
      // 3 done, all on their first attempt.
      expect(result.stdout).toContain('3/3 done on attempt 1 (100.0%)');
      expect(result.stdout).toContain('Plateau');
      expect(result.stdout).toContain('Escalation rungs');
      expect(result.stdout).toContain('model');
      expect(result.stdout).toContain('best-of-n');
      expect(result.stdout).toContain('criteria');
      // The attempt-based taxonomy sits beside the task-based rates, each naming its denominator.
      expect(result.stdout).toContain('· 3 attempts');
      expect(result.stdout).toContain('Attribution (of 3 attempts)');
      expect(result.stdout).toContain('Warnings (of 3 attempts)');
      expect(result.stdout).toContain('Aborts (of 3 attempts)');
      expect(result.stdout).toContain('Outcome mix (of 5 tasks)');
      // Multi-sprint scope keeps the per-sprint breakdown.
      expect(result.stdout).toContain('By sprint');
      expect(result.stdout).toContain('alpha sprint');
      expect(result.stdout).toContain('beta sprint');
    });

    it('reports the empty state with a friendly one-liner and exit 0', async () => {
      const result = await runCliCaptured(cli, ['runs', 'stats']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no sprints yet');
      expect(result.stderr).toBe('');
    });
  });

  describe('--json', () => {
    it('prints the raw rollup — totals plus a per-sprint breakdown', async () => {
      const sprint = await seedActiveSprint(cli, {
        name: 'json sprint',
        activatedAt: '2026-05-08T10:00:00.000Z',
        tasks: [makeDoneTask({ name: 'ok' }), makeDoneTaskWithWarning({ name: 'warned' }), blockedTask('wedged')],
      });

      const result = await runCliCaptured(cli, ['runs', 'stats', '--json']);
      expect(result.exitCode).toBe(0);

      const stats = parseStats(result.stdout);
      expect(stats.sprintCount).toBe(1);
      expect(stats.totals.taskCount).toBe(3);
      expect(stats.totals.outcomes.byStatus.done).toBe(2);
      expect(stats.totals.outcomes.byStatus.blocked).toBe(1);
      expect(stats.totals.outcomes.doneClean).toBe(1);
      expect(stats.totals.outcomes.doneWithWarning).toBe(1);
      expect(stats.totals.firstPass).toEqual({ doneOnFirstAttempt: 2, doneTotal: 2, rate: 1 });
      expect(stats.totals.plateau.tasksWithPlateau).toBe(1);
      expect(stats.bySprint).toHaveLength(1);
      expect(stats.bySprint[0]?.sprintId).toBe(String(sprint.id));
      expect(stats.bySprint[0]?.sprintName).toBe('json sprint');
    });

    it('carries the attempt-based taxonomy blocks with every key present', async () => {
      await seedActiveSprint(cli, {
        name: 'taxonomy sprint',
        activatedAt: '2026-05-08T10:00:00.000Z',
        tasks: [makeDoneTask({ name: 'ok' }), makeDoneTaskWithWarning({ name: 'warned' })],
      });

      const stats = parseStats((await runCliCaptured(cli, ['runs', 'stats', '--json'])).stdout);

      expect(stats.totals.attemptCount).toBe(2);
      expect(Object.keys(stats.totals.attribution.byVerdict).sort()).toEqual([
        'baseline-broken',
        'clean',
        'fixed-baseline',
        'regressed',
        'unspecified',
      ]);
      expect(stats.totals.attribution.byVerdict.unspecified).toBe(2);
      expect(stats.totals.warnings.byKind.plateau).toBe(1);
      expect(stats.totals.aborts.attemptsAborted).toBe(0);
      // Same four blocks ride every per-sprint entry, not just the totals.
      expect(stats.bySprint[0]?.rollup.attribution.byVerdict.regressed).toBe(0);
      expect(stats.bySprint[0]?.rollup.aborts.byCause['rate-limit-exhausted']).toBe(0);
    });

    it('stays machine-parseable (all-zero rollup) when nothing matches', async () => {
      const result = await runCliCaptured(cli, ['runs', 'stats', '--json']);
      expect(result.exitCode).toBe(0);
      const stats = parseStats(result.stdout);
      expect(stats.sprintCount).toBe(0);
      expect(stats.totals.taskCount).toBe(0);
      expect(stats.totals.firstPass.rate).toBe(0);
      expect(stats.totals.attemptCount).toBe(0);
      expect(stats.totals.attribution.regressionRate).toBe(0);
    });
  });

  describe('--since', () => {
    it('keeps only sprints whose latest lifecycle stamp is on or after the cutoff', async () => {
      await seedActiveSprint(cli, {
        name: 'old sprint',
        activatedAt: '2026-05-08T10:00:00.000Z',
        tasks: [makeDoneTask({ name: 'old work' })],
      });
      await seedActiveSprint(cli, {
        name: 'recent sprint',
        activatedAt: '2026-07-08T10:00:00.000Z',
        tasks: [makeDoneTask({ name: 'new work' }), blockedTask('new blocker')],
      });

      const result = await runCliCaptured(cli, ['runs', 'stats', '--json', '--since', '2026-06-01']);
      expect(result.exitCode).toBe(0);

      const stats = parseStats(result.stdout);
      expect(stats.sprintCount).toBe(1);
      expect(stats.bySprint[0]?.sprintName).toBe('recent sprint');
      expect(stats.totals.taskCount).toBe(2);
    });

    it('drops never-planned drafts (no lifecycle stamp = no activity to date)', async () => {
      await seedDraftSprint(cli, 'draft sprint', [makeDoneTask({ name: 'orphan' })]);

      const unfiltered = parseStats((await runCliCaptured(cli, ['runs', 'stats', '--json'])).stdout);
      expect(unfiltered.sprintCount).toBe(1);

      const filtered = await runCliCaptured(cli, ['runs', 'stats', '--json', '--since', '2020-01-01']);
      expect(filtered.exitCode).toBe(0);
      expect(parseStats(filtered.stdout).sprintCount).toBe(0);
    });

    it('reports the filtered-empty state with a scope hint and exit 0', async () => {
      await seedActiveSprint(cli, {
        name: 'old sprint',
        activatedAt: '2026-05-08T10:00:00.000Z',
        tasks: [makeDoneTask({ name: 'old work' })],
      });

      const result = await runCliCaptured(cli, ['runs', 'stats', '--since', '2027-01-01']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no sprints match this scope');
    });

    it('exits 1 on an unparseable date', async () => {
      const result = await runCliCaptured(cli, ['runs', 'stats', '--since', 'last-tuesday']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--since must be an ISO date');
    });
  });

  describe('--sprint', () => {
    it('narrows the rollup to one sprint', async () => {
      const target = await seedActiveSprint(cli, {
        name: 'target sprint',
        activatedAt: '2026-05-08T10:00:00.000Z',
        tasks: [makeDoneTask({ name: 'in scope' })],
      });
      await seedActiveSprint(cli, {
        name: 'other sprint',
        activatedAt: '2026-05-09T10:00:00.000Z',
        tasks: [blockedTask('out of scope'), makeTodoTask({ name: 'also out' })],
      });

      const result = await runCliCaptured(cli, ['runs', 'stats', '--json', '--sprint', String(target.id)]);
      expect(result.exitCode).toBe(0);

      const stats = parseStats(result.stdout);
      expect(stats.sprintCount).toBe(1);
      expect(stats.totals.taskCount).toBe(1);
      expect(stats.totals.outcomes.byStatus.done).toBe(1);
      expect(stats.totals.outcomes.byStatus.blocked).toBe(0);
    });

    it('omits the per-sprint breakdown for a single-sprint scope', async () => {
      const target = await seedActiveSprint(cli, {
        name: 'solo sprint',
        activatedAt: '2026-05-08T10:00:00.000Z',
        tasks: [makeDoneTask({ name: 'only' })],
      });

      const result = await runCliCaptured(cli, ['runs', 'stats', '--sprint', String(target.id)]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Harness outcomes — 1 sprint · 1 task');
      expect(result.stdout).not.toContain('By sprint');
    });

    it('exits 1 on a malformed sprint id', async () => {
      const result = await runCliCaptured(cli, ['runs', 'stats', '--sprint', 'nope']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid sprint id');
    });

    it('exits 1 on an unknown (but well-formed) sprint id rather than folding an empty report', async () => {
      const result = await runCliCaptured(cli, ['runs', 'stats', '--sprint', '01900000-0000-7000-8000-00000000ffff']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('error:');
    });
  });

  describe('--project', () => {
    it("narrows the rollup to that project's sprints", async () => {
      await createFsProjectRepository({ root: cli.paths.dataRoot }).save(makeProject());
      await seedActiveSprint(cli, {
        name: 'in project',
        activatedAt: '2026-05-08T10:00:00.000Z',
        tasks: [makeDoneTask({ name: 'mine' })],
      });
      await seedActiveSprint(cli, {
        name: 'other project sprint',
        activatedAt: '2026-05-09T10:00:00.000Z',
        projectId: SECOND_PROJECT_ID,
        tasks: [blockedTask('theirs'), makeTodoTask({ name: 'theirs too' })],
      });

      const result = await runCliCaptured(cli, ['runs', 'stats', '--json', '--project', String(FIXED_PROJECT_ID)]);
      expect(result.exitCode).toBe(0);

      const stats = parseStats(result.stdout);
      expect(stats.sprintCount).toBe(1);
      expect(stats.bySprint[0]?.sprintName).toBe('in project');
      expect(stats.totals.taskCount).toBe(1);
    });

    it('exits 1 when combined with --sprint', async () => {
      const result = await runCliCaptured(cli, [
        'runs',
        'stats',
        '--sprint',
        '01900000-0000-7000-8000-00000000ffff',
        '--project',
        String(FIXED_PROJECT_ID),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('mutually exclusive');
    });

    it('exits 1 on an unknown project id', async () => {
      const result = await runCliCaptured(cli, ['runs', 'stats', '--project', String(SECOND_PROJECT_ID)]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('error:');
    });
  });
});
