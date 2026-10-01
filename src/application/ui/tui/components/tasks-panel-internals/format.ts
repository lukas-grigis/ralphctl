/** Pure formatting helpers + display constants for the Tasks panel. */

import type { AbortCause } from '@src/domain/entity/attempt.ts';
import type { ContextCompactedSignal, HarnessSignal } from '@src/domain/signal.ts';
import { sanitizeDisplayText } from '@src/domain/value/display-text.ts';
import type { TaskProjection } from '@src/application/ui/tui/components/tasks-projection.ts';
import { fmtTokens } from '@src/application/ui/tui/components/format.ts';
import { glyphs, type SignalKind } from '@src/application/ui/tui/theme/tokens.ts';

/**
 * Collapse runs of whitespace to a single space so multi-line content (e.g. a `task-verified` signal's `output`)
 * renders as one row before Ink ellides on width.
 */
export const collapseWhitespace = (s: string): string => sanitizeDisplayText(s).replace(/\s+/g, ' ');

const SIGNAL_KIND_LABELS = [
  'change',
  'learning',
  'decision',
  'commit',
  'note',
  'done',
  'verified',
  'blocked',
  'script',
  'proposal',
  'skills',
  'reproduce',
  'judge',
] as const satisfies readonly SignalKind[];

/** The longest `SignalKind` label — the kind column is exactly this wide so only the message truncates. */
export const SIGNAL_LABEL_WIDTH = Math.max(...SIGNAL_KIND_LABELS.map((l) => l.length));

/** `HH:MM:SS` — never wraps. */
export const TIME_COL_WIDTH = 8;

/** Kind column: 2-cell gap, NO_COLOR shape glyph + space, padded label. */
export const KIND_COL_WIDTH = 2 + 2 + SIGNAL_LABEL_WIDTH;

export const padLabel = (label: string): string => label.padEnd(SIGNAL_LABEL_WIDTH, ' ');

/** Render the parenthetical detail block of a `context-compacted` marker. */
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
 * Format an ETA (milliseconds remaining) as `~Xm Ys`. For sub-minute durations the minutes field is omitted; the
 * result is `~Ys`.
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
 * Derive ETA text for the active-task header from the projected task. The estimate uses the median settled round
 * duration over the remaining rounds in the gen-eval loop.
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
 * User-facing label for an {@link AbortCause}. `undefined` means "omit the parenthetical" — we don't show `(unknown)`
 * because it adds noise without adding information.
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
    case 'self-blocked':
      return 'self-blocked';
    case 'unknown':
      return undefined;
  }
};

/**
 * Idle-ticker threshold: render the muted ticker line when the active task is `running` AND the latest stream signal
 * is older than this many milliseconds.
 */
export const IDLE_TICKER_THRESHOLD_MS = 10_000;

/**
 * Walk a task's signal list right-to-left and collect the last 1–2 `note` / `learning` signals' bodies.
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

/** Number of criterion bullets to render in the collapsed-summary form. */
export const CRITERIA_COLLAPSED_LINES = 3;

/** Which gen-eval role is currently busy, derived from the task's sub-step trace. */
export const resolveActiveRole = (
  subSteps: ReadonlyArray<{ readonly leafName: string }>
): 'generator' | 'evaluator' | undefined => {
  const last = subSteps[subSteps.length - 1];
  if (last === undefined) return undefined;
  if (last.leafName.includes('generator')) return 'generator';
  if (last.leafName.includes('evaluator')) return 'evaluator';
  return undefined;
};
