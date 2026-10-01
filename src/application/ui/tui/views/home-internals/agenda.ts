/**
 * Work's agenda — one ordered list answering "is something stuck, what's running, what next, which key?": NEEDS YOU →
 * RUNNING → NEXT → FLOWS.
 */

import { flowRegistry } from '@src/application/registry.ts';
import { glyphFor, glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtElapsed, fmtSpan } from '@src/application/ui/tui/theme/duration.ts';
import { plural } from '@src/application/ui/shared/plural.ts';
import type { NextStep } from '@src/application/ui/shared/next-steps.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { interruptedTasksOf, type InterruptedFacts } from '@src/application/ui/shared/interrupted-tasks.ts';
import { budgetedAttemptCount, resumesFreeAttempt } from '@src/domain/entity/task-attempts.ts';
import { sectionFor, sectionRank } from '@src/application/ui/tui/views/flows-visibility.ts';

export type AgendaSectionId = 'needs-you' | 'running' | 'next' | 'flows';
export type AgendaTone = 'error' | 'warning' | 'info' | 'success' | 'muted' | 'highlight';

export type AgendaAction =
  | { readonly kind: 'open-task'; readonly taskId: string }
  | { readonly kind: 'open-session'; readonly sessionId: string }
  | { readonly kind: 'launch-flow'; readonly flowId: string }
  | { readonly kind: 'open-sprint' };

export interface AgendaRow {
  readonly id: string;
  readonly section: AgendaSectionId;
  readonly glyph?: string;
  readonly tone: AgendaTone;
  readonly label: string;
  /** Right-aligned short fact (`verify failed`, elapsed time). */
  readonly fact?: string;
  /** Inline dim text after the label (a flow's description). */
  readonly note?: string;
  /** Second line, shown only while focused. */
  readonly detail?: string;
  /** Flow cost note from the manifest, shown only while focused. */
  readonly costHint?: string;
  readonly action: AgendaAction;
  /** Footer verb for ↵ on this row: `open task`, `open run`, `run <flow>`. */
  readonly verb: string;
  /** Present on a row the cursor must skip (an unavailable flow under `v`). */
  readonly disabledReason?: string;
}

export interface AgendaSession {
  readonly id: string;
  readonly flowId: string;
  readonly status: 'idle' | 'running' | 'completed' | 'failed' | 'aborted';
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly pinnedSprintId?: string;
  readonly progress?: {
    readonly taskId?: string;
    readonly taskIndex: number;
    readonly taskCount: number;
    readonly taskName: string;
    readonly attempt?: number;
    readonly maxAttempts?: number;
  };
}

export type AgendaLaunchability = { readonly ok: true } | { readonly ok: false; readonly disabledReason: string };

export interface BuildAgendaInput {
  readonly tasks: readonly Task[];
  readonly sprintId: string | undefined;
  readonly sessions: readonly AgendaSession[];
  /** Sessions parked on a prompt → epoch ms they started waiting. */
  readonly awaitingSince: ReadonlyMap<string, number>;
  readonly nextSteps: readonly NextStep[];
  readonly visibleFlows: ReadonlySet<string>;
  readonly showAll: boolean;
  readonly launchability: (flowId: string) => AgendaLaunchability;
  readonly now: number;
  /** Disk facts for interrupted tasks, keyed by task id; they arrive after the row, which renders without them. */
  readonly interruptedFacts?: ReadonlyMap<string, InterruptedFacts>;
  /** Another live ralphctl process works this sprint (or that is still being checked): nothing is interrupted. */
  readonly sprintOwnedElsewhere?: boolean;
}

export const NEEDS_YOU_TASK_CAP = 3;
const NEEDS_YOU: AgendaSectionId = 'needs-you';
const IMPLEMENT = 'implement';
const LAUNCH_FLOW = 'launch-flow' as const;
const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

const BLOCK_FACT: Readonly<Record<string, string>> = {
  'generator-self-block': 'generator blocked',
  'pre-verify-red': 'baseline red',
  'post-verify-regression': 'verify failed',
  'fold-conflict': 'fold conflict',
  'worktree-setup-failure': 'setup failed',
  'operator-cancelled': 'cancelled',
  'budget-exhausted': 'out of attempts',
};

const firstLine = (text: string): string => text.split('\n')[0]?.trim() ?? '';

/** Upstream-blocked tasks reachable from `root` through `dependsOn` — they wait on it, transitively. */
const dependentsOf = (root: Task, upstream: readonly Task[]): number => {
  const waiting = new Set<string>([root.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of upstream) {
      if (!waiting.has(t.id) && t.dependsOn.some((d) => waiting.has(d))) {
        waiting.add(t.id);
        grew = true;
      }
    }
  }
  return waiting.size - 1;
};

const needsYouTasks = (tasks: readonly Task[]): readonly AgendaRow[] => {
  const blocked = tasks.flatMap((t) => (t.status === 'blocked' ? [t] : []));
  const own = blocked.filter((t) => t.blockKind === 'own');
  const upstream = blocked.filter((t) => t.blockKind === 'upstream');
  const rows = own.slice(0, NEEDS_YOU_TASK_CAP).map((task): AgendaRow => {
    const waiting = dependentsOf(task, upstream);
    const reason = task.status === 'blocked' ? firstLine(task.blockedReason) : '';
    const cause = task.status === 'blocked' ? task.blockCause : undefined;
    const detail = [
      reason,
      waiting > 0 ? `${plural(waiting, 'more task')} ${waiting === 1 ? 'waits' : 'wait'} on it` : '',
    ]
      .filter((p) => p.length > 0)
      .join(` ${glyphs.bullet} `);
    return {
      id: `task:${task.id}`,
      section: NEEDS_YOU,
      glyph: glyphFor('blocked'),
      tone: 'error',
      label: `"${task.name}" is blocked`,
      fact: (cause !== undefined ? BLOCK_FACT[cause] : undefined) ?? 'blocked',
      ...(detail.length > 0 ? { detail } : {}),
      action: { kind: 'open-task', taskId: task.id },
      verb: 'open task',
    };
  });
  const overflow = own.length - rows.length;
  if (overflow > 0) {
    rows.push({
      id: 'needs-you:overflow',
      section: NEEDS_YOU,
      glyph: glyphs.moreBelow,
      tone: 'muted',
      label: `${String(overflow)} more blocked ${glyphs.emDash} o open sprint`,
      action: { kind: 'open-sprint' },
      verb: 'open sprint',
    });
  }
  return rows;
};

/** What the operator needs to know before resuming; unknown facts are left out rather than guessed. */
const interruptedDetail = (facts: InterruptedFacts | undefined): string | undefined => {
  const parts = [
    facts?.uncommitted !== undefined && facts.uncommitted > 0
      ? `${plural(facts.uncommitted, 'uncommitted change')}`
      : undefined,
    facts?.resumable === true ? 'session resumable' : undefined,
    facts?.resumable === false ? 'no session to resume, restarts from the brief' : undefined,
  ].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join(` ${glyphs.bullet} `) : undefined;
};

const RESUME_IMPLEMENT: Pick<AgendaRow, 'action' | 'verb'> = {
  action: { kind: LAUNCH_FLOW, flowId: IMPLEMENT },
  verb: 'resume implement',
};

const interruptedRows = (input: BuildAgendaInput): readonly AgendaRow[] => {
  const implementRunning = input.sessions.some(
    (s) => s.status === 'running' && s.flowId === IMPLEMENT && s.pinnedSprintId === input.sprintId
  );
  const all = interruptedTasksOf(input.tasks, implementRunning || input.sprintOwnedElsewhere === true);
  const rows = all.slice(0, NEEDS_YOU_TASK_CAP).map((task): AgendaRow => {
    const facts = input.interruptedFacts?.get(task.taskId);
    const detail = interruptedDetail(facts);
    return {
      id: `interrupted:${task.taskId}`,
      section: NEEDS_YOU,
      glyph: glyphs.warningGlyph,
      tone: 'warning',
      label: `"${task.name}" was interrupted`,
      fact: `attempt ${String(task.attemptN)} ${glyphs.bullet} ${fmtSpan(Math.max(0, input.now - (facts?.since ?? task.startedAt)))} ago`,
      ...(detail !== undefined ? { detail } : {}),
      ...RESUME_IMPLEMENT,
    };
  });
  const overflow = all.length - rows.length;
  if (overflow > 0) {
    rows.push({
      id: 'interrupted:overflow',
      section: NEEDS_YOU,
      glyph: glyphs.moreBelow,
      tone: 'muted',
      label: `${String(overflow)} more interrupted ${glyphs.emDash} resume picks them all up`,
      ...RESUME_IMPLEMENT,
    });
  }
  return rows;
};

const failedSessions = (input: BuildAgendaInput): readonly AgendaRow[] =>
  input.sessions
    .filter(
      (s) =>
        (s.status === 'failed' || s.status === 'aborted') &&
        s.pinnedSprintId === input.sprintId &&
        input.now - (s.finishedAt ?? s.startedAt) < FAILED_WINDOW_MS
    )
    .map((s): AgendaRow => ({
      id: `run:${s.id}`,
      section: NEEDS_YOU,
      glyph: glyphs.cross,
      tone: 'error',
      label: `${s.flowId} ${s.status === 'failed' ? 'failed' : 'aborted'} ${fmtSpan(input.now - (s.finishedAt ?? s.startedAt))} ago`,
      action: { kind: 'open-session', sessionId: s.id },
      verb: 'open run',
    }));

/** From the persisted task when possible: the trace only knows this run's attempts, not the free ones before it. */
const attemptChip = (p: NonNullable<AgendaSession['progress']>, tasks: readonly Task[]): string | undefined => {
  if (p.maxAttempts === undefined) return undefined;
  const task = tasks.find((t) => t.id === p.taskId && t.attempts.at(-1)?.status === 'running');
  if (task === undefined) {
    return p.attempt !== undefined ? `attempt ${String(p.attempt)}/${String(p.maxAttempts)}` : undefined;
  }
  const chip = `attempt ${String(budgetedAttemptCount(task))}/${String(p.maxAttempts)}`;
  return resumesFreeAttempt(task) ? `${chip} ${glyphs.bullet} resumed` : chip;
};

const runningRows = (input: BuildAgendaInput): readonly AgendaRow[] =>
  input.sessions
    .filter((s) => s.status === 'running' && s.pinnedSprintId === input.sprintId)
    .map((s): AgendaRow => {
      const p = s.progress;
      const parts = [s.flowId];
      if (p !== undefined) {
        parts.push(`task ${String(p.taskIndex)}/${String(p.taskCount)} "${p.taskName}"`);
        const chip = attemptChip(p, input.tasks);
        if (chip !== undefined) parts.push(chip);
      }
      const waitingSince = input.awaitingSince.get(s.id);
      return {
        id: `run:${s.id}`,
        section: 'running',
        glyph: glyphs.phaseActive,
        tone: waitingSince !== undefined ? 'warning' : 'info',
        label: parts.join(` ${glyphs.bullet} `),
        fact:
          waitingSince !== undefined
            ? `[WAITING] waiting ${fmtElapsed(waitingSince, input.now)}`
            : fmtElapsed(s.startedAt, input.now),
        action: { kind: 'open-session', sessionId: s.id },
        verb: 'open run',
      };
    });

const nextRows = (input: BuildAgendaInput, runningFlowIds: ReadonlySet<string>): readonly AgendaRow[] =>
  input.nextSteps.flatMap((step): AgendaRow[] => {
    if (step.flow === undefined || runningFlowIds.has(step.flow)) return [];
    return [
      {
        id: `flow:${step.flow}`,
        section: 'next',
        glyph: glyphs.phaseActive,
        tone: 'highlight',
        label: step.label,
        ...(step.detail !== undefined ? { note: step.detail } : {}),
        action: { kind: LAUNCH_FLOW, flowId: step.flow },
        verb: `run ${step.label}`,
      },
    ];
  });

const flowRows = (input: BuildAgendaInput, claimed: ReadonlySet<string>): readonly AgendaRow[] =>
  flowRegistry
    .filter((e) => input.visibleFlows.has(e.manifest.id) && !claimed.has(e.manifest.id))
    .map((e) => ({ entry: e, check: input.launchability(e.manifest.id) }))
    .filter(({ check }) => input.showAll || check.ok)
    .sort((a, b) => sectionRank(sectionFor(a.entry.manifest.id)) - sectionRank(sectionFor(b.entry.manifest.id)))
    .map(({ entry, check }): AgendaRow => ({
      id: `flow:${entry.manifest.id}`,
      section: 'flows',
      tone: check.ok ? 'highlight' : 'muted',
      label: entry.manifest.title,
      note: entry.manifest.description,
      ...(entry.manifest.costHint !== undefined ? { costHint: entry.manifest.costHint } : {}),
      action: { kind: LAUNCH_FLOW, flowId: entry.manifest.id },
      verb: `run ${entry.manifest.title}`,
      ...(check.ok ? {} : { disabledReason: check.disabledReason }),
    }));

export const buildAgenda = (input: BuildAgendaInput): readonly AgendaRow[] => {
  const runningFlowIds = new Set(
    input.sessions.filter((s) => s.status === 'running' && s.pinnedSprintId === input.sprintId).map((s) => s.flowId)
  );
  const interrupted = interruptedRows(input);
  // Resuming Implement is the interrupted row's ↵, so NEXT never offers the same flow a second time.
  const next = nextRows(input, interrupted.length > 0 ? new Set([...runningFlowIds, IMPLEMENT]) : runningFlowIds);
  // A flow NEXT recommends never repeats under FLOWS — even while NEXT hides it because it runs.
  const claimed = new Set(input.nextSteps.flatMap((s) => (s.flow !== undefined ? [s.flow] : [])));
  return [
    ...interrupted,
    ...needsYouTasks(input.tasks),
    ...failedSessions(input),
    ...runningRows(input),
    ...next,
    ...flowRows(input, claimed),
  ];
};

/** First cursor target: NEEDS YOU, else NEXT, else the first enabled FLOWS row. */
export const initialAgendaRowId = (rows: readonly AgendaRow[]): string | undefined => {
  const pick = (section: AgendaSectionId): AgendaRow | undefined =>
    rows.find((r) => r.section === section && r.disabledReason === undefined);
  return (pick('needs-you') ?? pick('next') ?? pick('flows'))?.id;
};
