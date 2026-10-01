/** Keyboard model for the Tasks panel. */

import { useInput, type Key } from 'ink';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { isCommitMessageKey } from '@src/application/ui/tui/components/tasks-panel-internals/focus-keys.ts';

export interface UseTasksPanelInputArgs {
  readonly inputActive: boolean;
  readonly bucketed: BucketedExecution;
  readonly flatKeys: readonly string[];
  readonly focusedKey: string | undefined;
  readonly focusedIndex: number;
  readonly effectiveFocusedKey: string | undefined;
  readonly effectiveCardCursor: number;
  readonly focusedCardId: string | undefined;
  readonly focusedCardExpanded: boolean;
  readonly activeTaskId: string | undefined;
  readonly expandedTaskIds: ReadonlySet<string>;
  readonly setFocusedKey: (key: string | undefined) => void;
  readonly setExpandedKeys: (updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
  readonly setCardCursor: (index: number) => void;
  readonly setExpandedTaskIds: (updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
  readonly setCriteriaExpandedIds: (updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
  /** Task ids that have a recorded evaluation verdict — the gate for the `v` chord. */
  readonly evaluationTaskIds: ReadonlySet<string>;
  /** Absent when the host doesn't wire the evaluation overlay; `v` is then a no-op. */
  readonly onOpenEvaluation?: (taskId: string) => void;
  /** Task ids the host considers stuck (entity `status === 'blocked'`) — the gate for the `u` chord. */
  readonly blockedTaskIds: ReadonlySet<string>;
  /** Absent when the host doesn't wire the unblock affordance; `u` is then a no-op. */
  readonly onUnblock?: (taskId: string) => void;
}

/** Toggles membership of `id` in `set`, returning a fresh `Set` (never mutates the input). */
const toggleSetMembership = <T>(set: ReadonlySet<T>, id: T): Set<T> => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

const handleCriteriaToggle = (
  input: string,
  focusedCardId: string | undefined,
  activeTaskId: string | undefined,
  setCriteriaExpandedIds: (updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void
): boolean => {
  // Done-criteria toggle, anchored on the FOCUSED card with the active (running) task as a fallback — matching how
  // `handleOpenEvaluation` resolves its target below.
  const target = focusedCardId ?? activeTaskId;
  if (input !== 'e' || target === undefined) return false;
  setCriteriaExpandedIds((prev) => toggleSetMembership(prev, target));
  return true;
};

/** `v` opens the read-only evaluation overlay for the FOCUSED card — not the active one. */
const handleOpenEvaluation = (
  input: string,
  focusedCardId: string | undefined,
  evaluationTaskIds: ReadonlySet<string>,
  onOpenEvaluation: ((taskId: string) => void) | undefined
): boolean => {
  if (input !== 'v' || onOpenEvaluation === undefined) return false;
  if (focusedCardId === undefined || !evaluationTaskIds.has(focusedCardId)) return false;
  onOpenEvaluation(focusedCardId);
  return true;
};

/**
 * `u` revives the FOCUSED card's stuck task (not the active one), like {@link handleOpenEvaluation}. Returns `false`
 * when the target isn't blocked, so the keystroke keeps travelling.
 */
const handleUnblock = (
  input: string,
  focusedCardId: string | undefined,
  blockedTaskIds: ReadonlySet<string>,
  onUnblock: ((taskId: string) => void) | undefined
): boolean => {
  if (input !== 'u' || onUnblock === undefined) return false;
  if (focusedCardId === undefined || !blockedTaskIds.has(focusedCardId)) return false;
  onUnblock(focusedCardId);
  return true;
};

const handleEscapeCollapse = (
  key: Key,
  focusedCardId: string | undefined,
  expandedTaskIds: ReadonlySet<string>,
  setExpandedTaskIds: (updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void
): boolean => {
  // Esc collapses an expanded focused card.
  if (!key.escape) return false;
  if (focusedCardId !== undefined && expandedTaskIds.has(focusedCardId)) {
    setExpandedTaskIds((prev) => {
      const next = new Set(prev);
      next.delete(focusedCardId);
      return next;
    });
  }
  return true;
};

interface VerticalMoveArgs {
  readonly focusedCardExpanded: boolean;
  readonly flatKeys: readonly string[];
  readonly focusedIndex: number;
  readonly tasksLength: number;
  readonly effectiveCardCursor: number;
  readonly setFocusedKey: (key: string | undefined) => void;
  readonly setCardCursor: (index: number) => void;
}

// j / k AND ↑ / ↓ share one cursor; the scope shifts with the focused card's state and the current row-cursor anchor.
const handleVerticalMove = (direction: 1 | -1, input: string, key: Key, args: VerticalMoveArgs): boolean => {
  const isDown = direction === 1;
  const matchesKey = isDown ? key.downArrow || input === 'j' : key.upArrow || input === 'k';
  if (!matchesKey) return false;

  const {
    focusedCardExpanded,
    flatKeys,
    focusedIndex,
    tasksLength,
    effectiveCardCursor,
    setFocusedKey,
    setCardCursor,
  } = args;
  const rowCursorActive = focusedCardExpanded && flatKeys.length > 0 && focusedIndex >= 0;
  if (isDown) {
    if (rowCursorActive && focusedIndex < flatKeys.length - 1) {
      setFocusedKey(flatKeys[focusedIndex + 1]);
      return true;
    }
    // Row cursor at the bottom — fall through to the card cursor.
    const next = Math.min(tasksLength - 1, effectiveCardCursor + 1);
    setCardCursor(next);
    // Reset the row cursor so the next expanded card starts un-anchored.
    setFocusedKey(undefined);
    return true;
  }
  if (rowCursorActive && focusedIndex > 0) {
    setFocusedKey(flatKeys[focusedIndex - 1]);
    return true;
  }
  // Row cursor at the top — fall through to the card cursor.
  const next = Math.max(0, effectiveCardCursor - 1);
  setCardCursor(next);
  setFocusedKey(undefined);
  return true;
};

interface SelectKeyArgs {
  readonly bucketed: BucketedExecution;
  readonly flatKeys: readonly string[];
  readonly focusedKey: string | undefined;
  readonly focusedIndex: number;
  readonly effectiveFocusedKey: string | undefined;
  readonly focusedCardId: string | undefined;
  readonly focusedCardExpanded: boolean;
  readonly setFocusedKey: (key: string | undefined) => void;
  readonly setExpandedKeys: (updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
  readonly setExpandedTaskIds: (updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
}

const handleSelectKey = (input: string, key: Key, args: SelectKeyArgs): void => {
  if (!(key.return || input === ' ')) return;
  const {
    bucketed,
    flatKeys,
    focusedKey,
    focusedIndex,
    effectiveFocusedKey,
    focusedCardId,
    focusedCardExpanded,
    setFocusedKey,
    setExpandedKeys,
    setExpandedTaskIds,
  } = args;

  // Card-scope: toggle the focused card's expansion. Row-scope only kicks in when the
  // card is already expanded AND a row cursor is anchored.
  const rowCursorAnchored = focusedCardExpanded && flatKeys.length > 0 && focusedIndex >= 0;
  if (focusedCardId !== undefined && !rowCursorAnchored) {
    setExpandedTaskIds((prev) => toggleSetMembership(prev, focusedCardId));
    return;
  }
  // Row-scope: existing commit-message toggle behaviour.
  if (flatKeys.length === 0) return;
  const target = focusedIndex >= 0 ? focusedKey : flatKeys[flatKeys.length - 1];
  if (target === undefined) return;
  if (!isCommitMessageKey(target, bucketed)) {
    if (effectiveFocusedKey === undefined) setFocusedKey(target);
    return;
  }
  setExpandedKeys((prev) => toggleSetMembership(prev, target));
  if (effectiveFocusedKey === undefined) setFocusedKey(target);
};

export const useTasksPanelInput = ({
  inputActive,
  bucketed,
  flatKeys,
  focusedKey,
  focusedIndex,
  effectiveFocusedKey,
  effectiveCardCursor,
  focusedCardId,
  focusedCardExpanded,
  activeTaskId,
  expandedTaskIds,
  setFocusedKey,
  setExpandedKeys,
  setCardCursor,
  setExpandedTaskIds,
  setCriteriaExpandedIds,
  evaluationTaskIds,
  onOpenEvaluation,
  blockedTaskIds,
  onUnblock,
}: UseTasksPanelInputArgs): void => {
  useInput(
    (input, key) => {
      if (handleCriteriaToggle(input, focusedCardId, activeTaskId, setCriteriaExpandedIds)) return;
      if (handleOpenEvaluation(input, focusedCardId, evaluationTaskIds, onOpenEvaluation)) return;
      if (handleUnblock(input, focusedCardId, blockedTaskIds, onUnblock)) return;
      if (handleEscapeCollapse(key, focusedCardId, expandedTaskIds, setExpandedTaskIds)) return;
      const verticalMoveArgs: VerticalMoveArgs = {
        focusedCardExpanded,
        flatKeys,
        focusedIndex,
        tasksLength: bucketed.tasks.length,
        effectiveCardCursor,
        setFocusedKey,
        setCardCursor,
      };
      if (handleVerticalMove(1, input, key, verticalMoveArgs)) return;
      if (handleVerticalMove(-1, input, key, verticalMoveArgs)) return;
      handleSelectKey(input, key, {
        bucketed,
        flatKeys,
        focusedKey,
        focusedIndex,
        effectiveFocusedKey,
        focusedCardId,
        focusedCardExpanded,
        setFocusedKey,
        setExpandedKeys,
        setExpandedTaskIds,
      });
    },
    { isActive: inputActive }
  );
};
