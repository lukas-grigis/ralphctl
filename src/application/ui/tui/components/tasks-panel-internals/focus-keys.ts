/**
 * Focus-key plumbing for the Tasks panel cursor model. Keys are stable across re-renders
 * (composed of `scope:absoluteIndex`) so a moving cursor doesn't jump when a new signal lands.
 */

import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';

/**
 * Build a stable focusable-row key. Composed of `scope:absoluteIndex` where `scope` is either
 * the literal string `orphan` or a task id (uuid v7). Absolute index is the signal's position
 * in the original (unsliced) signal array — surviving the slice means the key stays valid even
 * when newer signals push older ones off the visible window.
 */
export const focusKey = (scope: string, absoluteIndex: number): string => `${scope}:${String(absoluteIndex)}`;

/**
 * Predicate: is this signal type focusable in the cursor model? Non-focusable signals are
 * either rendered by a dedicated component outside the signal stream (evaluation) or render as
 * a dedented lifecycle boundary (context-compacted) where focus would feel out of place.
 */
export const isFocusable = (sig: HarnessSignal): boolean =>
  sig.type !== 'evaluation' && sig.type !== 'context-compacted';

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
 * Compute the flat sequence of focusable row keys in render order: orphans first (matching
 * the on-screen ordering), then each task's visible signal slice. Keys are stable across
 * re-renders so a moving cursor doesn't jump when a new signal lands; non-focusable signals
 * (`evaluation`, `context-compacted`) are excluded from the cursor model but still render.
 */
export const buildFlatFocusKeys = (
  bucketed: BucketedExecution,
  maxSignalsPerTask: number,
  maxOrphanSignals: number
): readonly string[] => {
  const keys: string[] = [];
  const orphanSliceLen = Math.min(bucketed.orphanSignals.length, maxOrphanSignals);
  const orphanSliceStart = bucketed.orphanSignals.length - orphanSliceLen;
  const orphanSlice = bucketed.orphanSignals.slice(-orphanSliceLen);
  for (const k of focusKeysForSlice('orphan', orphanSlice, orphanSliceStart)) keys.push(k);
  for (const task of bucketed.tasks) {
    const sliceLen = Math.min(task.signals.length, maxSignalsPerTask);
    const sliceStart = task.signals.length - sliceLen;
    const slice = task.signals.slice(-sliceLen);
    for (const k of focusKeysForSlice(task.id, slice, sliceStart)) keys.push(k);
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
