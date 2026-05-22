import type {
  BlockerEntry,
  DecisionEntry,
  RunBoundary,
  SprintState,
  SprintStateBranch,
  SprintStateCounts,
  SprintStateIdentity,
  SprintStateStatus,
  StaleEntry,
  TaskProjection,
  TaskSignalEntry,
  TicketSummary,
} from '@src/business/sprint/state-projection.ts';

/**
 * Render a `SprintState` projection into a `progress.md` document targeting a fresh AI session
 * bootstrapping with zero conversation context.
 *
 * Pure, deterministic — same state in, same string out. No I/O.
 *
 * The document is structured for a next-agent reader (Anthropic's "Effective Harnesses" framing):
 * the file is the source of truth a re-entering agent reads to reconstruct sprint state without
 * any prior conversation. Sections with no content are omitted entirely — empty placeholders
 * (`(none)`) leak noise into the agent's context window.
 *
 * Presentation rules live here (status synthesis, duration formatting, sha truncation, hours
 * rounding), not on the state model — the projection stays a normalised view-model.
 * @public
 */
export const renderProgressMarkdown = (state: SprintState): string => {
  const sections: string[] = [];

  sections.push(renderHeader(state.identity));
  sections.push(renderStatus(state.identity, state.status, state.counts));

  const branchBlock = renderBranchAndPr(state.branch);
  if (branchBlock !== undefined) sections.push(branchBlock);

  const ticketsBlock = renderTickets(state.tickets);
  if (ticketsBlock !== undefined) sections.push(ticketsBlock);

  const tasksBlock = renderTasks(state.tasks);
  if (tasksBlock !== undefined) sections.push(tasksBlock);

  if (state.blockers.length > 0) sections.push(renderBlockers(state.blockers));
  if (state.staleTasks.length > 0) sections.push(renderStale(state.staleTasks));
  if (state.dependencyCycles.length > 0) sections.push(renderCycles(state.dependencyCycles));
  if (state.decisions.length > 0) sections.push(renderDecisions(state.decisions));
  if (state.runs.length > 0) sections.push(renderRecentRuns(state.runs));

  return `${sections.join('\n\n')}\n`;
};

// ───────────────────────── header / status ─────────────────────────

const renderHeader = (identity: SprintStateIdentity): string => `# Sprint progress — ${identity.name}`;

const renderStatus = (identity: SprintStateIdentity, status: SprintStateStatus, counts: SprintStateCounts): string => {
  const lines: string[] = ['## Status'];
  lines.push(`- id: ${identity.id}`);
  lines.push(`- status: ${status.effective}`);
  lines.push(`- ${counts.done}/${counts.total} done · ${counts.inProgress} in progress · ${counts.blocked} blocked`);
  lines.push(`- ${renderLifecycleTimestamps(identity)}`);
  return lines.join('\n');
};

const renderLifecycleTimestamps = (identity: SprintStateIdentity): string => {
  const parts: string[] = [];
  parts.push(`activated: ${identity.activatedAt !== undefined ? String(identity.activatedAt) : '—'}`);
  if (identity.reviewAt !== undefined) parts.push(`review: ${String(identity.reviewAt)}`);
  if (identity.doneAt !== undefined) parts.push(`done: ${String(identity.doneAt)}`);
  return parts.join(' · ');
};

// ───────────────────────── branch + PR ─────────────────────────

const renderBranchAndPr = (branch: SprintStateBranch): string | undefined => {
  const lines: string[] = [];
  if (branch.name !== undefined) {
    const mismatch = branch.actual !== undefined && branch.expected !== undefined && branch.actual !== branch.expected;
    if (mismatch) {
      lines.push(`- branch: ${branch.name} (expected ${String(branch.expected)}, actual ${String(branch.actual)})`);
    } else {
      lines.push(`- branch: ${branch.name}`);
    }
  }
  if (branch.pullRequestUrl !== undefined) {
    lines.push(`- pull request: ${String(branch.pullRequestUrl)}`);
  }
  if (lines.length === 0) return undefined;
  return ['## Branch & PR', ...lines].join('\n');
};

// ───────────────────────── tickets ─────────────────────────

const renderTickets = (tickets: readonly TicketSummary[]): string | undefined => {
  if (tickets.length === 0) return undefined;
  const lines: string[] = ['## Tickets'];
  for (const ticket of tickets) {
    const ref = ticket.externalRef !== undefined ? ` [${ticket.externalRef}]` : '';
    lines.push(`- ${ticket.id} — ${ticket.title}${ref}`);
    lines.push(`  status: ${ticket.status}`);
  }
  return lines.join('\n');
};

// ───────────────────────── tasks sub-sections ─────────────────────────

/**
 * Display cap for a per-signal body line (changes / learnings / notes). More generous than
 * {@link DECISION_DISPLAY_CAP} because these signals are user-facing prose with multi-clause
 * detail (the AI is encouraged to be descriptive — "renamed X to Y because the old name
 * collided with Z and the rename simplifies callers …"). 240 chars fits a typical change
 * description without clipping while still bounding any pathological runaway entry.
 */
const SIGNAL_TEXT_DISPLAY_CAP = 240;

const clipSignalText = (text: string): string => {
  if (text.length <= SIGNAL_TEXT_DISPLAY_CAP) return text;
  const overflow = text.length - SIGNAL_TEXT_DISPLAY_CAP;
  return `${text.slice(0, SIGNAL_TEXT_DISPLAY_CAP)}… (+${overflow} chars)`;
};

const renderTasks = (tasks: readonly TaskProjection[]): string | undefined => {
  if (tasks.length === 0) return undefined;
  const lines: string[] = ['## Tasks'];
  for (const task of tasks) {
    if (lines.length > 1) lines.push('');
    lines.push(...renderTaskSection(task));
  }
  return lines.join('\n');
};

const renderTaskSection = (task: TaskProjection): readonly string[] => {
  const lines: string[] = [];
  lines.push(`### Task ${task.order} — ${task.name}`);
  const commit = task.lastAttempt?.commitSha !== undefined ? truncateSha(task.lastAttempt.commitSha) : '—';
  lines.push(`status: ${task.status} · attempts: ${task.attemptsCount} · commit: ${commit}`);
  if (task.status === 'blocked' && task.blockReason !== undefined && task.blockReason.length > 0) {
    lines.push('');
    lines.push(`> Why blocked: ${task.blockReason}`);
  }
  appendSignalSubSection(lines, 'Changes', task.changes);
  appendSignalSubSection(lines, 'Learnings', task.learnings);
  appendSignalSubSection(lines, 'Notes', task.notes);
  return lines;
};

const appendSignalSubSection = (
  acc: string[],
  heading: 'Changes' | 'Learnings' | 'Notes',
  entries: readonly TaskSignalEntry[]
): void => {
  if (entries.length === 0) return;
  acc.push('');
  acc.push(`#### ${heading}`);
  for (const entry of entries) {
    acc.push(`- ${clipSignalText(entry.text)}`);
  }
};

// ───────────────────────── blockers / stale / cycles ─────────────────────────

const renderBlockers = (blockers: readonly BlockerEntry[]): string => {
  const lines: string[] = ['## Blockers'];
  for (const b of blockers) lines.push(`- ✗ ${b.name} — ${b.detail}`);
  return lines.join('\n');
};

const renderStale = (stale: readonly StaleEntry[]): string => {
  const lines: string[] = ['## Stale tasks'];
  for (const s of stale) lines.push(`- ⚠ ${s.name} — ${formatStaleAge(s)}`);
  return lines.join('\n');
};

const formatStaleAge = (entry: StaleEntry): string => {
  if (entry.hoursSinceSignal === undefined) return 'no signal recorded';
  return `${formatHoursSince(entry.hoursSinceSignal)} since last signal`;
};

const renderCycles = (cycles: ReadonlyArray<readonly string[]>): string => {
  const lines: string[] = ['## Dependency cycles'];
  for (const cycle of cycles) lines.push(`- ${cycle.join(' → ')}`);
  return lines.join('\n');
};

// ───────────────────────── decisions / runs ─────────────────────────

/**
 * Per-line display cap for a decision message in `progress.md`. Shorter than the parser /
 * sink cap (500) because this section is a human-facing scan list — a runaway entry that
 * slipped past both upstream guards still gets visually clipped with a `(+N chars)` hint
 * so the operator can see something was truncated rather than reading a wall of text.
 */
const DECISION_DISPLAY_CAP = 160;

const clipDecisionMessage = (message: string): string => {
  if (message.length <= DECISION_DISPLAY_CAP) return message;
  const overflow = message.length - DECISION_DISPLAY_CAP;
  return `${message.slice(0, DECISION_DISPLAY_CAP)}… (+${overflow} chars)`;
};

const renderDecisions = (decisions: readonly DecisionEntry[]): string => {
  const lines: string[] = ['## Decisions'];
  for (const d of decisions) {
    const tag = pickDecisionTag(d);
    lines.push(`- ${String(d.at)} [${tag}] ${clipDecisionMessage(d.message)}`);
  }
  return lines.join('\n');
};

const pickDecisionTag = (decision: DecisionEntry): string => {
  const taskId = decision.meta?.['taskId'];
  if (typeof taskId === 'string' && taskId.length > 0) return taskId;
  return decision.chainId;
};

const RECENT_RUNS_LIMIT = 3;

const renderRecentRuns = (runs: readonly RunBoundary[]): string => {
  const newestFirst = [...runs].reverse().slice(0, RECENT_RUNS_LIMIT);
  const lines: string[] = ['## Recent runs'];
  for (const run of newestFirst) {
    const flow = run.flowId ?? 'unknown';
    const steps = `${run.stepsCompleted}/${run.stepsCompleted + run.stepsFailed} steps`;
    const duration = formatRunDuration(run);
    lines.push(`- ${run.chainId} · ${flow} · ${run.outcome} · ${duration} · ${steps}`);
  }
  return lines.join('\n');
};

const formatRunDuration = (run: RunBoundary): string => {
  if (run.finishedAt === undefined) return 'in-progress';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return formatDuration(ms);
};

// ───────────────────────── presentation helpers ─────────────────────────

const SHA_DISPLAY_LENGTH = 7;
const truncateSha = (sha: string): string => sha.slice(0, SHA_DISPLAY_LENGTH);

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * Format a millisecond duration. `<1000ms` renders as `<n>ms` so sub-second runs remain
 * inspectable; everything else condenses into the largest non-zero `Xh Ym Zs` group.
 */
const formatDuration = (ms: number): string => {
  if (ms < 0) return `${ms}ms`;
  if (ms < MS_PER_SECOND) return `${ms}ms`;
  if (ms < MS_PER_MINUTE) {
    const seconds = Math.floor(ms / MS_PER_SECOND);
    return `${seconds}s`;
  }
  if (ms < MS_PER_HOUR) {
    const minutes = Math.floor(ms / MS_PER_MINUTE);
    const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
  const parts: string[] = [`${hours}h`];
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(' ');
};

const HOURS_PER_DAY = 24;
const DAY_ROLLOVER_HOURS = 48;

/**
 * Stale-age formatting: whole-hour `<N>h` up to 48h, then `<N>d` (days, floored). Mirrors the
 * spec's "round to whole hours, `Nd` after 48h."
 */
const formatHoursSince = (hours: number): string => {
  if (!Number.isFinite(hours) || hours < 0) return '0h';
  if (hours >= DAY_ROLLOVER_HOURS) {
    const days = Math.floor(hours / HOURS_PER_DAY);
    return `${days}d`;
  }
  const rounded = Math.round(hours);
  return `${rounded}h`;
};
