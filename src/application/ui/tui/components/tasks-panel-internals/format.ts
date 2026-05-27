/**
 * Pure formatting helpers + display constants for the Tasks panel. No React, no Ink — every
 * function here is testable in isolation and re-used across {@link signal-rows.tsx},
 * {@link evaluation-row.tsx}, {@link task-row.tsx}, and the panel orchestrator.
 */

import type { AbortCause } from '@src/domain/entity/attempt.ts';
import type { ContextCompactedSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { TaskProjection } from '@src/application/ui/tui/components/tasks-projection.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

/**
 * Collapse runs of whitespace to a single space so multi-line content (e.g. a `task-verified`
 * signal's `output`) renders as one row before Ink ellides on width. We deliberately do not
 * char-clip here — Ink's `wrap="truncate-end"` handles width-based ellision based on actual
 * terminal columns.
 */
export const collapseWhitespace = (s: string): string => s.replace(/\s+/g, ' ');

/** Fixed label column so timestamps and bodies line up across signals. */
export const SIGNAL_LABEL_WIDTH = 16;

export const padLabel = (label: string): string => label.padEnd(SIGNAL_LABEL_WIDTH, ' ');

/**
 * Disclosure markers for collapsible commit-message rows. Glyphs chosen for clear visual
 * affinity (right-pointing → collapsed, down-pointing → expanded) and Unicode coverage in the
 * vt220 / Powerline glyph families every modern terminal emulator ships.
 */
export const COLLAPSED_DISCLOSURE = '▸';
export const EXPANDED_DISCLOSURE = '▾';
/** Cursor caret for the focused signal row. Same vocabulary as the global action cursor. */
export const FOCUS_CURSOR = '›';

/**
 * Compact a token count for display: `200000` → `200k`, `1500` → `1.5k`, `120` → `120`. The
 * provider's reported numbers can be large (context windows trend 100k-200k); collapsing to a
 * one-or-two-char "k" suffix keeps the marker scannable inside one terminal row.
 */
export const fmtTokens = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return k >= 100 ? `${String(Math.round(k))}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
};

/**
 * Render the parenthetical detail block of a `context-compacted` marker. Returns `undefined`
 * when neither token counts nor preserved topics were reported by the provider — the marker
 * then degrades gracefully to the bare "context compacted" boundary.
 */
export const formatCompactionDetail = (sig: ContextCompactedSignal): string | undefined => {
  const parts: string[] = [];
  if (sig.beforeTokens !== undefined && sig.afterTokens !== undefined) {
    parts.push(`${fmtTokens(sig.beforeTokens)} ${glyphs.arrowRight} ${fmtTokens(sig.afterTokens)}`);
  } else if (sig.beforeTokens !== undefined) {
    parts.push(`from ${fmtTokens(sig.beforeTokens)}`);
  } else if (sig.afterTokens !== undefined) {
    parts.push(`to ${fmtTokens(sig.afterTokens)}`);
  }
  if (sig.preservedTopics !== undefined && sig.preservedTopics.length > 0) {
    parts.push(`kept: ${String(sig.preservedTopics.length)} topic${sig.preservedTopics.length === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
};

/**
 * Format an ETA (milliseconds remaining) as `~Xm Ys`. For sub-minute durations the minutes
 * field is omitted; the result is `~Ys`. Negative / NaN values degrade to `undefined` so the
 * header renders no ETA chip at all rather than misleading "negative time remaining" text.
 */
export const fmtEta = (ms: number): string | undefined => {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `~${String(s)}s`;
  return `~${String(m)}m ${String(s).padStart(2, '0')}s`;
};

/**
 * Derive ETA text for the active-task header from the projected task. The estimate uses the
 * median settled round duration over the remaining rounds in the gen-eval loop. Returns the
 * pre-formatted string `· ~Xm Ys remaining` ready to splice into the header, or
 * `· no ETA yet` when the projection has no median yet (first round of first task, or any
 * task whose attempts haven't settled). When the cap is already reached, returns `undefined`
 * so the chip is dropped instead of stale.
 */
export const formatEtaChip = (
  projection: TaskProjection | undefined,
  currentRound: number,
  maxRounds: number | undefined
): string | undefined => {
  if (projection === undefined) return undefined;
  if (maxRounds === undefined || maxRounds <= 0) return undefined;
  const remaining = Math.max(0, maxRounds - Math.max(0, currentRound));
  if (remaining === 0) return undefined;
  const median = projection.medianRoundDurationMs;
  if (median === undefined || median <= 0) {
    return `${glyphs.bullet} no ETA yet`;
  }
  const text = fmtEta(median * remaining);
  if (text === undefined) return undefined;
  return `${glyphs.bullet} ${text} remaining`;
};

/**
 * User-facing label for an {@link AbortCause}. `undefined` means "omit the parenthetical" —
 * we don't show `(unknown)` because it adds noise without adding information. Keeping this in
 * the TUI rather than under domain/ because it's purely a TUI concern (the same cause surfaces
 * in chain.log with its raw discriminator).
 */
export const abortCauseLabel = (cause: AbortCause): string | undefined => {
  switch (cause) {
    case 'user-cancel':
      return 'Ctrl-C';
    case 'sigterm':
      return 'SIGTERM';
    case 'watchdog-killed':
      return 'watchdog timeout';
    case 'rate-limit-exhausted':
      return 'rate limit';
    case 'process-crash':
      return 'process crash';
    case 'unknown':
      return undefined;
  }
};

/**
 * Idle-ticker threshold: render the muted ticker line when the active task is `running` AND
 * the latest stream signal is older than this many milliseconds. Calibrated for the user's
 * perceptual "is anything happening" window — a 5 s gap is normal between tool calls; 10 s
 * starts to feel quiet.
 */
export const IDLE_TICKER_THRESHOLD_MS = 10_000;

/**
 * Walk a task's signal list right-to-left and collect the last 1–2 `note` / `learning`
 * signals' bodies. Returns the texts in newest-first order so the renderer can show a
 * compact "last + previous" pair. Empty when the task has no such signal — the ticker then
 * suppresses itself entirely rather than fabricating placeholder text.
 */
export const latestIdleSnippets = (signals: readonly HarnessSignal[]): readonly string[] => {
  const out: string[] = [];
  for (let i = signals.length - 1; i >= 0 && out.length < 2; i -= 1) {
    const s = signals[i];
    if (s === undefined) continue;
    if (s.type === 'note') out.push(s.text);
    else if (s.type === 'learning') out.push(s.text);
  }
  return out;
};

/**
 * Number of criterion bullets to render in the collapsed-summary form. Three lines reads as a
 * glance preview without becoming a wall of text on tasks with many criteria; expanding via
 * `e` reveals the rest.
 */
export const CRITERIA_COLLAPSED_LINES = 3;
