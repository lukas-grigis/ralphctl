/**
 * `ShowProgressUseCase` — read sprint progress + diagnostics in one shot.
 *
 * Replaces the legacy `sprint health` command. Folds the timeline parsing,
 * blocker enumeration, stale-task detection, dependency-cycle checks, and
 * branch-consistency probes into a single typed report so the CLI and TUI
 * surfaces render the same information.
 *
 * The use case is read-only: it never mutates sprint or task state.
 *
 * Inputs:
 *  - `sprintId` — which sprint to read.
 *  - `now` — wall-clock anchor for stale-task scoring (injected for tests).
 *  - `staleThresholdHours` — cutoff above which an `in_progress` task is
 *    considered stale. Defaults to 24h.
 *
 * Output: {@link ProgressReport} — see field docs below.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Project } from '@src/domain/entities/project.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { ProjectRepository } from '@src/domain/repositories/project-repository.ts';
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repositories/task-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';
import { topologicalReorder } from '@src/kernel/algorithms/dependency-reorder.ts';
import type { ExternalPort } from '@src/business/ports/external-port.ts';

/** Single timeline entry parsed from progress.md. */
export interface TimelineEntry {
  /** ISO-8601 stamp when known; otherwise the raw token. */
  readonly timestamp: string;
  /** Body of the line, sans bullet/timestamp prefix. */
  readonly line: string;
}

/** Stale `in_progress` task — exceeded the threshold without a signal. */
export interface StaleTask {
  readonly task: Task;
  readonly hoursStale: number;
}

/** A blocked task plus the reason recorded with its `blocked` transition. */
export interface BlockedTaskRow {
  readonly task: Task;
  readonly reason: string;
}

/** Branch mismatch in one of the sprint's affected repos. */
export interface BranchInconsistency {
  readonly repoPath: AbsolutePath;
  readonly expected: string;
  readonly actual: string;
}

/** Aggregated sprint progress + health surface. */
export interface ProgressReport {
  readonly sprintId: SprintId;
  readonly sprintName: string;
  /**
   * Effective status for the surface: `'blocked'` when every remaining
   * task is blocked; otherwise the sprint's persisted lifecycle state.
   */
  readonly sprintStatus: 'draft' | 'active' | 'closed' | 'blocked';
  readonly tasks: readonly Task[];
  readonly timeline: readonly TimelineEntry[];
  readonly blockers: readonly BlockedTaskRow[];
  readonly staleTasks: readonly StaleTask[];
  /** Cycle ids in `tasks.blockedBy` graph; `null` if none. */
  readonly dependencyCycle: readonly TaskId[] | null;
  readonly branchInconsistency: readonly BranchInconsistency[];
}

/** Inputs to {@link ShowProgressUseCase}. */
export interface ShowProgressInput {
  readonly sprintId: SprintId;
  readonly now: IsoTimestamp;
  readonly staleThresholdHours?: number;
}

const DEFAULT_STALE_THRESHOLD_HOURS = 24;
/** Public for callers that want the same default surface in their UI. */
export const STALE_THRESHOLD_HOURS = DEFAULT_STALE_THRESHOLD_HOURS;

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const LEGACY_BRACKET_TS_RE = /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]\s*(.*)$/;
const NEW_FORMAT_RE = /^[-*•]\s+(\S+)\s+—\s+(.*)$/;

/**
 * Parse `progress.md` content into structured entries.
 *
 * Tolerates two formats:
 *  1. New (`FileSystemSignalHandler`) — `- <isoTimestamp> — <message>`
 *  2. Legacy (pre-rewrite) — `[YYYY-MM-DD HH:MM:SS] <message>`
 *
 * Lines that match neither are emitted with an empty timestamp so the
 * caller can choose whether to render them. A malformed line never
 * throws — the goal is "show what's there", not "validate the file".
 */
export function parseProgressTimeline(content: string): readonly TimelineEntry[] {
  if (content.length === 0) return [];
  const out: TimelineEntry[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;

    const newMatch = NEW_FORMAT_RE.exec(line);
    if (newMatch !== null) {
      const ts = newMatch[1] ?? '';
      const body = newMatch[2] ?? '';
      out.push({ timestamp: ts, line: body });
      continue;
    }

    const legacy = LEGACY_BRACKET_TS_RE.exec(line);
    if (legacy !== null) {
      const ts = legacy[1] ?? '';
      const body = legacy[2] ?? '';
      out.push({ timestamp: ts, line: body });
      continue;
    }

    // Unrecognised — surface the raw text with empty timestamp.
    out.push({ timestamp: '', line });
  }
  return out;
}

function timestampToMillis(ts: string): number | null {
  if (ts.length === 0) return null;
  if (!ISO_TIMESTAMP_RE.test(ts)) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Find the most recent timeline entry that mentions a particular task —
 * we look for the task id substring or the task name. Used as the staleness
 * signal: a task is "fresh" if there's been progress on it inside the
 * threshold window.
 */
function lastSignalMillisForTask(task: Task, timeline: readonly TimelineEntry[]): number | null {
  let best: number | null = null;
  for (const entry of timeline) {
    if (!entry.line.includes(String(task.id)) && !entry.line.includes(task.name)) continue;
    const ms = timestampToMillis(entry.timestamp);
    if (ms === null) continue;
    if (best === null || ms > best) best = ms;
  }
  return best;
}

/**
 * Return the cycle ids if `tasks.blockedBy` produces one. `null` when the
 * graph reorders cleanly (no cycle).
 */
function detectCycle(tasks: readonly Task[]): readonly TaskId[] | null {
  const result = topologicalReorder(
    tasks.map((t) => ({
      item: t,
      id: String(t.id),
      blockedBy: t.blockedBy.map((b) => String(b)),
    }))
  );
  if (result.ok) return null;
  if (result.error.code === 'cycle') {
    // The cycle is reported as raw id strings; the original task type
    // brand is preserved by the use case's input so downstream surfaces
    // can render them as is.
    return result.error.cycle as readonly TaskId[];
  }
  // unknown-dep — surface via a synthetic single-element cycle so the UI
  // still shows a problem (this means data is malformed — orphan dep ref).
  return [result.error.from as TaskId];
}

/**
 * Verify each repo with remaining tasks is on the sprint branch.
 * Skipped silently when the sprint has no `branch` configured.
 */
function detectBranchInconsistency(
  sprint: Sprint,
  projects: readonly Project[],
  external: ExternalPort
): readonly BranchInconsistency[] {
  if (sprint.branch === null) return [];

  const expected = sprint.branch;
  const repoPaths = new Set<AbsolutePath>();
  for (const path of sprint.affectedRepositories) {
    repoPaths.add(path);
  }
  // Fall back to every repo across registered projects when the sprint has
  // no affected repos recorded yet — gives the user actionable feedback even
  // before planning.
  if (repoPaths.size === 0) {
    for (const project of projects) {
      for (const repo of project.repositories) {
        repoPaths.add(repo.path);
      }
    }
  }

  const out: BranchInconsistency[] = [];
  for (const path of repoPaths) {
    if (external.verifyBranch(path, expected)) continue;
    out.push({
      repoPath: path,
      expected,
      actual: external.getCurrentBranch(path),
    });
  }
  return out;
}

export class ShowProgressUseCase {
  constructor(
    private readonly sprints: SprintRepository,
    private readonly tasks: TaskRepository,
    private readonly projects: ProjectRepository,
    private readonly external: ExternalPort,
    /**
     * Filesystem reader for `progress.md`. Defaults to `node:fs/promises#readFile`.
     * Tests inject a fake to avoid hitting disk.
     */
    private readonly readFileImpl: (path: string) => Promise<string> = (path) => readFile(path, 'utf-8'),
    /**
     * Resolves the on-disk location of `progress.md` for a sprint.
     * Defaults to `<root>/data/sprints/<id>/progress.md`. The default can
     * be overridden by the caller — the sprint repository in this branch
     * does not expose paths directly.
     */
    private readonly progressPathForSprint: (sprintId: SprintId) => string = (sprintId) =>
      join(process.env['RALPHCTL_ROOT'] ?? '', 'data', 'sprints', String(sprintId), 'progress.md')
  ) {}

  async execute(input: ShowProgressInput): Promise<Result<ProgressReport, DomainError>> {
    const sprintR = await this.sprints.findById(input.sprintId);
    if (!sprintR.ok) return Result.error(sprintR.error);
    const sprint = sprintR.value;

    const tasksR = await this.tasks.findBySprintId(input.sprintId);
    if (!tasksR.ok) return Result.error(tasksR.error);
    const tasks = tasksR.value;

    const projectsR = await this.projects.list();
    if (!projectsR.ok) return Result.error(projectsR.error);
    const projects = projectsR.value;

    let timelineContent: string;
    try {
      timelineContent = await this.readFileImpl(this.progressPathForSprint(input.sprintId));
    } catch {
      // Progress file may not exist yet — that's a normal state, not an
      // error.
      timelineContent = '';
    }
    const timeline = parseProgressTimeline(timelineContent);

    const blockers: BlockedTaskRow[] = [];
    for (const task of tasks) {
      if (task.status !== 'blocked') continue;
      blockers.push({ task, reason: task.blockedReason ?? 'no reason recorded' });
    }

    const thresholdMs = (input.staleThresholdHours ?? DEFAULT_STALE_THRESHOLD_HOURS) * 3_600_000;
    const nowMs = Date.parse(input.now);
    const staleTasks: StaleTask[] = [];
    if (Number.isFinite(nowMs)) {
      for (const task of tasks) {
        if (task.status !== 'in_progress') continue;
        const lastSignalMs = lastSignalMillisForTask(task, timeline);
        // No signal at all → definitely stale (we don't know when it
        // started). Use the threshold itself as a baseline so the row
        // still surfaces.
        const elapsedMs = lastSignalMs === null ? thresholdMs + 1 : nowMs - lastSignalMs;
        if (elapsedMs > thresholdMs) {
          staleTasks.push({ task, hoursStale: Math.floor(elapsedMs / 3_600_000) });
        }
      }
    }

    const dependencyCycle = detectCycle(tasks);
    const branchInconsistency = detectBranchInconsistency(sprint, projects, this.external);

    const remainingTasks = tasks.filter((t) => t.status !== 'done');
    const allBlocked = remainingTasks.length > 0 && remainingTasks.every((t) => t.status === 'blocked');

    return Result.ok({
      sprintId: sprint.id,
      sprintName: sprint.name,
      sprintStatus: allBlocked ? 'blocked' : sprint.status,
      tasks,
      timeline,
      blockers,
      staleTasks,
      dependencyCycle,
      branchInconsistency,
    });
  }
}
