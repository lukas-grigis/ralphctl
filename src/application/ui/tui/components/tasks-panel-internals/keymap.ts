/**
 * Keyboard model for the Tasks panel. Bundles the j/k/↑/↓ row+card cursor logic, the
 * Enter/Space toggle (card expand or commit-message body expand), `e` to toggle the active
 * task's criteria block, and Esc to collapse a focused expanded card.
 *
 * Extracted from the panel orchestrator so the input layer can be reasoned about in isolation
 * from the render tree.
 */

import { useInput } from 'ink';
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
}

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
}: UseTasksPanelInputArgs): void => {
  useInput(
    (input, key) => {
      // Done-criteria toggle for the active task. Independent of the card / row cursors: the
      // operator is virtually always reading the running task when this hotkey is reached.
      if (input === 'e' && activeTaskId !== undefined) {
        setCriteriaExpandedIds((prev) => {
          const next = new Set(prev);
          if (next.has(activeTaskId)) next.delete(activeTaskId);
          else next.add(activeTaskId);
          return next;
        });
        return;
      }
      // Esc collapses an expanded focused card. Works on any expanded card, including the
      // active task — the auto-expand-on-activation seed only fires when the active id
      // transitions, so collapsing it stays collapsed until the next transition.
      if (key.escape) {
        if (focusedCardId !== undefined && expandedTaskIds.has(focusedCardId)) {
          setExpandedTaskIds((prev) => {
            const next = new Set(prev);
            next.delete(focusedCardId);
            return next;
          });
        }
        return;
      }
      // j / k AND ↑ / ↓ share one cursor; the scope shifts with the focused card's state and
      // the current row-cursor anchor:
      //   - collapsed card → card cursor moves between cards.
      //   - expanded card AND a row cursor is already anchored → row cursor moves within the
      //     card; jumping past either edge hands off to the card cursor (no need to collapse
      //     the card first).
      //   - expanded card with no row anchor yet → card cursor (lets the operator pan
      //     between cards without first clicking into a row).
      const rowCursorActive = focusedCardExpanded && flatKeys.length > 0 && focusedIndex >= 0;
      if (key.downArrow || input === 'j') {
        if (rowCursorActive) {
          if (focusedIndex < flatKeys.length - 1) {
            setFocusedKey(flatKeys[focusedIndex + 1]);
            return;
          }
          // Row cursor at the bottom — fall through to the card cursor.
        }
        const next = Math.min(bucketed.tasks.length - 1, effectiveCardCursor + 1);
        setCardCursor(next);
        // Reset the row cursor so the next expanded card starts un-anchored.
        setFocusedKey(undefined);
        return;
      }
      if (key.upArrow || input === 'k') {
        if (rowCursorActive) {
          if (focusedIndex > 0) {
            setFocusedKey(flatKeys[focusedIndex - 1]);
            return;
          }
          // Row cursor at the top — fall through to the card cursor.
        }
        const next = Math.max(0, effectiveCardCursor - 1);
        setCardCursor(next);
        setFocusedKey(undefined);
        return;
      }
      if (key.return || input === ' ') {
        // Card-scope: toggle the focused card's expansion. Row-scope only kicks in when the
        // card is already expanded AND a row cursor is anchored.
        const rowCursorAnchored = focusedCardExpanded && flatKeys.length > 0 && focusedIndex >= 0;
        if (focusedCardId !== undefined && !rowCursorAnchored) {
          setExpandedTaskIds((prev) => {
            const next = new Set(prev);
            if (next.has(focusedCardId)) next.delete(focusedCardId);
            else next.add(focusedCardId);
            return next;
          });
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
        setExpandedKeys((prev) => {
          const next = new Set(prev);
          if (next.has(target)) next.delete(target);
          else next.add(target);
          return next;
        });
        if (effectiveFocusedKey === undefined) setFocusedKey(target);
      }
    },
    { isActive: inputActive }
  );
};
