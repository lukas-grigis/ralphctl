/**
 * Work's agenda — one ordered list answering "is something stuck, what's running, what next, which
 * key?": NEEDS YOU → RUNNING → NEXT → FLOWS. Pure: callers pass the clock and every lookup.
 */

import { flowRegistry } from '@src/application/registry.ts';
import { glyphFor, glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtElapsed, fmtSpan } from '@src/application/ui/tui/theme/duration.ts';
import { plural } from '@src/application/ui/shared/plural.ts';
import type { NextStep } from '@src/application/ui/shared/next-steps.ts';
import type { Task } from '@src/domain/entity/task.ts';
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
}

export const NEEDS_YOU_TASK_CAP = 3;
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
      section: 'needs-you',
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
      section: 'needs-you',
      glyph: glyphs.moreBelow,
      tone: 'muted',
      label: `${String(overflow)} more blocked ${glyphs.emDash} o open sprint`,
      action: { kind: 'open-sprint' },
      verb: 'open sprint',
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
      section: 'needs-you',
      glyph: glyphs.cross,
      tone: 'error',
      label: `${s.flowId} ${s.status === 'failed' ? 'failed' : 'aborted'} ${fmtSpan(input.now - (s.finishedAt ?? s.startedAt))} ago`,
      action: { kind: 'open-session', sessionId: s.id },
      verb: 'open run',
    }));

const runningRows = (input: BuildAgendaInput): readonly AgendaRow[] =>
  input.sessions
    .filter((s) => s.status === 'running' && s.pinnedSprintId === input.sprintId)
    .map((s): AgendaRow => {
      const p = s.progress;
      const parts = [s.flowId];
      if (p !== undefined) {
        parts.push(`task ${String(p.taskIndex)}/${String(p.taskCount)} "${p.taskName}"`);
        if (p.attempt !== undefined && p.maxAttempts !== undefined) {
          parts.push(`attempt ${String(p.attempt)}/${String(p.maxAttempts)}`);
        }
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
        action: { kind: 'launch-flow', flowId: step.flow },
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
      action: { kind: 'launch-flow', flowId: entry.manifest.id },
      verb: `run ${entry.manifest.title}`,
      ...(check.ok ? {} : { disabledReason: check.disabledReason }),
    }));

export const buildAgenda = (input: BuildAgendaInput): readonly AgendaRow[] => {
  const runningFlowIds = new Set(
    input.sessions.filter((s) => s.status === 'running' && s.pinnedSprintId === input.sprintId).map((s) => s.flowId)
  );
  const next = nextRows(input, runningFlowIds);
  // A flow NEXT recommends never repeats under FLOWS — even while NEXT hides it because it runs.
  const claimed = new Set(input.nextSteps.flatMap((s) => (s.flow !== undefined ? [s.flow] : [])));
  return [
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
