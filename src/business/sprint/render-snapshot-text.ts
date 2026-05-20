/**
 * Render a {@link SprintState} projection into a single static text frame for the CLI
 * `ralphctl snapshot` command. Parallel to {@link renderProgressMarkdown} — same projection,
 * different output medium — but tuned for terminal display rather than for a fresh AI session.
 *
 * Layout sections (each optional, omitted when empty):
 *
 *   1. Header line  — `Sprint: <name>` and the sprint id underneath
 *   2. Status block — project (when provided), branch, sprint status, task counts
 *   3. Tasks table  — pipe-delimited table mirroring `progress.md`'s `## Tasks` layout
 *   4. Active line  — the in-flight task + its latest sub-step, when the projection reports one
 *   5. Recent signals — the last 5 signals across every task in newest-first order
 *
 * Pure, deterministic — same state in, same string out. No I/O, no clock reads. The recent-
 * signals tail is sourced from `state.runs` + `chainLogEntries` decoded through the projection
 * (see {@link RecentSignalsInput}); callers pass the chain-log slice directly because the
 * projection doesn't carry per-task signals (only decisions). Keeping the renderer pure over a
 * shape it shares with the projection means the unit test can pin exact byte output.
 *
 * @public
 */

import type {
  SprintState,
  SprintStateCounts,
  SprintStateIdentity,
  SprintStateStatus,
  SprintStateBranch,
  TaskProjection,
  ChainLogEntry,
} from '@src/business/sprint/state-projection.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/** Maximum recent-signal rows surfaced in the snapshot. Spec-driven. */
const RECENT_SIGNALS_LIMIT = 5;

/** @public */
export interface RenderSnapshotInput {
  readonly state: SprintState;
  /** Optional human-readable project label for the header. Defaults to "(no project)". */
  readonly projectLabel?: string;
  /**
   * Raw chain-log entries from `<sprintDir>/chain.log`. Read here to recover the signal stream
   * (the projection only retains a `decisions` slice, since `progress.md` doesn't carry the
   * full tail). Pass the same array used to build `state` so timestamps line up.
   */
  readonly chainLogEntries: readonly ChainLogEntry[];
}

/**
 * Top-level entry point — composes every section. Returns a single string ready for `stdout`,
 * trailing newline included.
 *
 * @public
 */
export const renderSnapshotText = (input: RenderSnapshotInput): string => {
  const { state, projectLabel, chainLogEntries } = input;
  const sections: string[] = [];

  sections.push(renderHeader(state.identity));
  sections.push(renderStatus(state.identity, state.status, state.counts, state.branch, projectLabel));

  const tasksBlock = renderTasksTable(state.tasks);
  if (tasksBlock !== undefined) sections.push(tasksBlock);

  const activeBlock = renderActive(state.tasks);
  if (activeBlock !== undefined) sections.push(activeBlock);

  const recentBlock = renderRecentSignals(chainLogEntries);
  if (recentBlock !== undefined) sections.push(recentBlock);

  return `${sections.join('\n\n')}\n`;
};

// ───────────────────────── header / status ─────────────────────────

const renderHeader = (identity: SprintStateIdentity): string => `Sprint: ${identity.name}\n  id: ${identity.id}`;

const renderStatus = (
  identity: SprintStateIdentity,
  status: SprintStateStatus,
  counts: SprintStateCounts,
  branch: SprintStateBranch,
  projectLabel: string | undefined
): string => {
  const lines: string[] = ['Status'];
  lines.push(`  project: ${projectLabel ?? '(no project)'}`);
  lines.push(`  status:  ${status.effective}`);
  lines.push(`  branch:  ${branch.name ?? '(none — first implement run will assign one)'}`);
  if (branch.pullRequestUrl !== undefined) lines.push(`  pr:      ${branch.pullRequestUrl}`);
  lines.push(
    `  tasks:   ${String(counts.done)}/${String(counts.total)} done · ${String(counts.inProgress)} in progress · ${String(counts.todo)} todo · ${String(counts.blocked)} blocked`
  );
  if (identity.activatedAt !== undefined) lines.push(`  activated: ${String(identity.activatedAt)}`);
  if (identity.reviewAt !== undefined) lines.push(`  review:    ${String(identity.reviewAt)}`);
  if (identity.doneAt !== undefined) lines.push(`  done:      ${String(identity.doneAt)}`);
  return lines.join('\n');
};

// ───────────────────────── tasks table ─────────────────────────

const SHA_DISPLAY_LENGTH = 7;
const truncateSha = (sha: string): string => sha.slice(0, SHA_DISPLAY_LENGTH);

/**
 * Pipe-delimited markdown-style table — same layout as `## Tasks` in `progress.md` for visual
 * continuity. The CLI fixed-width terminal reads it the same way the markdown reads on disk.
 */
const renderTasksTable = (tasks: readonly TaskProjection[]): string | undefined => {
  if (tasks.length === 0) return undefined;
  const lines: string[] = [
    'Tasks',
    '  | # | name | status | attempts | last verdict | commit |',
    '  |---|------|--------|----------|--------------|--------|',
  ];
  for (const task of tasks) {
    const verdict = task.lastAttempt?.verdict ?? '';
    const commit = task.lastAttempt?.commitSha !== undefined ? truncateSha(task.lastAttempt.commitSha) : '';
    lines.push(
      `  | ${String(task.order)} | ${task.name} | ${task.status} | ${String(task.attemptsCount)} | ${verdict} | ${commit} |`
    );
  }
  return lines.join('\n');
};

// ───────────────────────── active attempt ─────────────────────────

/**
 * Surface the first non-done task as "active" — matches the Implement view's `currentTask`
 * heuristic so the snapshot mirrors what the live TUI shows. When every task is done (or no
 * tasks exist) the block is omitted.
 */
const renderActive = (tasks: readonly TaskProjection[]): string | undefined => {
  const active = tasks.find((t) => t.status !== 'done');
  if (active === undefined) return undefined;
  const lines: string[] = ['Active'];
  lines.push(`  task:     ${active.name}`);
  lines.push(`  status:   ${active.status}`);
  if (active.lastAttempt !== undefined) {
    const att = active.lastAttempt;
    lines.push(
      `  attempt:  n=${String(att.n)}${att.verdict !== undefined ? ` · last verdict ${att.verdict}` : ''}${att.status === 'running' ? ' · running' : ''}`
    );
  }
  return lines.join('\n');
};

// ───────────────────────── recent signals tail ─────────────────────────

/**
 * Pluck the last {@link RECENT_SIGNALS_LIMIT} signal-bearing chain-log entries — newest first.
 * "Signal-bearing" here means a log line with `meta.signalKind` set (the file-log sink stamps
 * every harness signal that way). We do NOT cross-correlate to a task id; the CLI only needs a
 * temporal tail for the operator's "what just happened" question.
 */
const renderRecentSignals = (entries: readonly ChainLogEntry[]): string | undefined => {
  const signalEntries: readonly ChainLogEntry[] = entries.filter(isSignalEntry);
  if (signalEntries.length === 0) return undefined;
  const newest = [...signalEntries].slice(-RECENT_SIGNALS_LIMIT).reverse();
  const lines: string[] = ['Recent signals'];
  for (const entry of newest) {
    const kind = pickSignalKind(entry);
    const msg = entry.message.length > 0 ? entry.message : '(no message)';
    lines.push(`  ${formatShortTime(entry.timestamp)}  ${kind.padEnd(10)}  ${msg}`);
  }
  return lines.join('\n');
};

const isSignalEntry = (entry: ChainLogEntry): boolean => {
  const kind = entry.meta?.['signalKind'];
  return typeof kind === 'string' && kind.length > 0;
};

const pickSignalKind = (entry: ChainLogEntry): string => {
  const kind = entry.meta?.['signalKind'];
  return typeof kind === 'string' ? kind : 'signal';
};

const formatShortTime = (timestamp: IsoTimestamp): string => {
  // Format HH:MM:SS in UTC; the operator's local-vs-UTC mental model is unimportant for a
  // forensic snapshot.
  const d = new Date(String(timestamp));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
