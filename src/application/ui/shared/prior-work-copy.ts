/**
 * The one-line card notice about a task's rejected diff in git stash — shared by the Execute Tasks
 * panel and Sprint detail so both read the same. Pure; glyphs come from the theme tokens.
 */

import type { PriorWorkNotRestoredReason, PriorWorkOutcome } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { formatDiffStat, type DiffStat } from '@src/domain/value/diff-stat.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

export interface PriorWorkNotice {
  readonly tone: 'dim' | 'warning';
  readonly icon: string;
  readonly text: string;
}

export type PriorWorkSurface = 'execute' | 'sprint-detail';

const statSuffix = (stat: DiffStat | undefined, sep: string): string =>
  stat === undefined ? '' : `${sep}${formatDiffStat(stat)}`;

const reasonText = (reason: PriorWorkNotRestoredReason, uncommittedPaths: number | undefined): string => {
  switch (reason) {
    case 'dirty-tree':
      return uncommittedPaths === undefined
        ? 'tree had uncommitted changes'
        : `tree had ${String(uncommittedPaths)} uncommitted change${uncommittedPaths === 1 ? '' : 's'}`;
    case 'tree-probe-failed':
      return 'git status failed';
    case 'pop-failed':
      return 'stash pop conflicted and the tree was reset';
    case 'pop-failed-tree-unverified':
      return "stash pop failed and the tree couldn't be checked";
    case 'stash-list-failed':
      return 'git stash list failed';
  }
};

const attemptNotice = (outcome: PriorWorkOutcome): PriorWorkNotice => {
  switch (outcome.kind) {
    case 'restored':
      return {
        tone: 'dim',
        icon: glyphs.refresh,
        text: `continued from earlier rejected work${statSuffix(outcome.stat, ` ${glyphs.bullet} `)}`,
      };
    case 'kept-by-choice':
      return {
        tone: 'dim',
        icon: glyphs.infoGlyph,
        text: `started fresh by choice ${glyphs.bullet} rejected diff still in git stash`,
      };
    case 'not-restored':
      return {
        tone: 'warning',
        icon: glyphs.warningGlyph,
        text: `earlier rejected work not restored ${glyphs.emDash} ${reasonText(outcome.reason, outcome.uncommittedPaths)}; still in git stash`,
      };
  }
};

const taskNotice = (task: Task, surface: PriorWorkSurface): PriorWorkNotice | undefined => {
  const fact = task.quarantinedDiff;
  if (fact === undefined) return undefined;
  const dot = glyphs.bullet;
  if (task.status === 'blocked') {
    const u = surface === 'sprint-detail' ? 'u unblocks and decides' : 'u decides';
    return {
      tone: 'dim',
      icon: glyphs.infoGlyph,
      text: `rejected diff kept in git stash${statSuffix(fact.stat, ` ${dot} `)} ${dot} ${u} what the next attempt does`,
    };
  }
  if (task.status !== 'todo') return undefined;
  if (fact.nextAttempt === 'fresh') {
    const stat = fact.stat === undefined ? '' : ` (${formatDiffStat(fact.stat)})`;
    return {
      tone: 'dim',
      icon: glyphs.infoGlyph,
      text: `next attempt starts fresh ${dot} rejected diff stays in git stash${stat}`,
    };
  }
  if (fact.nextAttempt === 'continue') {
    return {
      tone: 'dim',
      icon: glyphs.refresh,
      text: `next attempt continues from the rejected diff${statSuffix(fact.stat, ` ${dot} `)}`,
    };
  }
  return {
    tone: 'dim',
    icon: glyphs.refresh,
    text: 'next attempt restores the rejected diff in git stash (no choice recorded)',
  };
};

/** The card notice for this task, or `undefined` when there is nothing to say. A current-attempt stamp wins over the task fact. */
export const priorWorkNotice = (task: Task, surface: PriorWorkSurface = 'execute'): PriorWorkNotice | undefined => {
  const current = task.status === 'in_progress' ? task.attempts[task.attempts.length - 1] : undefined;
  if (current?.priorWork !== undefined) return attemptNotice(current.priorWork);
  return taskNotice(task, surface);
};
