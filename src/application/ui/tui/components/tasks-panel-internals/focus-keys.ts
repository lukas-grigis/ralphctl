/** Focus-key plumbing for the Tasks panel cursor model. */

import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { rowForSignal } from '@src/application/ui/tui/components/tasks-panel-internals/signal-rows.tsx';

/**
 * Build a stable focusable-row key. Composed of `scope:absoluteIndex` where `scope` is either the literal string
 * `orphan` or a task id (uuid v7).
 */
export const focusKey = (scope: string, absoluteIndex: number): string => `${scope}:${String(absoluteIndex)}`;

// Derived from the renderer so the cursor never lands on a row that renders nothing (or only a compaction marker).
/** Predicate: is this signal type focusable in the cursor model? */
export const isFocusable = (sig: HarnessSignal): boolean => rowForSignal(sig) !== undefined;

/** Last `max` entries + absolute start; renderers and focus keys share it to agree (`slice(-0)` would return all). */
export const tailSlice = <T>(
  list: readonly T[],
  max: number
): { readonly rows: readonly T[]; readonly start: number } => {
  if (max <= 0) return { rows: [], start: list.length };
  const start = Math.max(0, list.length - max);
  return { rows: list.slice(start), start };
};

/** Build the visible row keys for one scope's signal slice. */
export const focusKeysForSlice = (
  scope: string,
  signals: readonly HarnessSignal[],
  sliceStart: number
): readonly string[] => {
  const out: string[] = [];
  for (let i = 0; i < signals.length; i += 1) {
    const sig = signals[i];
    if (sig === undefined) continue;
    if (isFocusable(sig)) out.push(focusKey(scope, sliceStart + i));
  }
  return out;
};

/**
 * Compute the flat sequence of focusable row keys in render order: orphans first (matching the on-screen ordering),
 * then each task's visible signal slice.
 */
export const buildFlatFocusKeys = (
  bucketed: BucketedExecution,
  maxSignalsPerTask: number,
  maxOrphanSignals: number
): readonly string[] => {
  const keys: string[] = [];
  const orphans = tailSlice(bucketed.orphanSignals, maxOrphanSignals);
  for (const k of focusKeysForSlice('orphan', orphans.rows, orphans.start)) keys.push(k);
  for (const task of bucketed.tasks) {
    const { rows, start } = tailSlice(task.signals, maxSignalsPerTask);
    for (const k of focusKeysForSlice(task.id, rows, start)) keys.push(k);
  }
  return keys;
};

/** Test if a focus key points at a `commit-message` signal in the bucketed view. */
export const isCommitMessageKey = (key: string, bucketed: BucketedExecution): boolean => {
  const sep = key.indexOf(':');
  if (sep < 0) return false;
  const scope = key.slice(0, sep);
  const idx = Number(key.slice(sep + 1));
  if (!Number.isFinite(idx)) return false;
  if (scope === 'orphan') {
    return bucketed.orphanSignals[idx]?.type === 'commit-message';
  }
  const task = bucketed.tasks.find((t) => t.id === scope);
  return task?.signals[idx]?.type === 'commit-message';
};
