import { contextWindowFor } from '@src/domain/value/settings-models/context-window.ts';
import {
  extractLifecycleBreadcrumbs,
  renderBreadcrumbBand,
  sectionBelongsToTask,
  splitJournal,
} from '@src/business/sprint/journal-structure.ts';

/**
 * Cap the inlined `progress.md` body — bounding BREADTH across other tasks while preserving the full
 * DEPTH of the current task's own history.
 *
 * `progress.md` is sprint-wide and append-only: every settled task-attempt appends one
 * `## Task: <name> — Attempt <N> · id:<taskId>` section. Late in a long sprint the file holds dozens
 * of sections, so inlining the WHOLE body into every gen-eval prompt (generator and evaluator, every
 * round) grows token cost superlinearly while the marginal value of a 20-attempts-ago sibling section
 * is near zero. Planning flows (plan / ideate / refine) read the same file and apply the same cap.
 *
 * Three parts ride:
 *
 *   1. The header band — everything before the first `## Task:` delimiter (sprint identity + the
 *      DERIVED state header + lifecycle separators). Small and invariant, so it always rides verbatim.
 *   2. EVERY section belonging to the current task, matched by its STABLE id token (not its name).
 *      This is the depth correctness demands: the current task's earlier attempts carry the warnings,
 *      escalations, and remedies the next attempt must honour, and they must never fall out of a
 *      recency window just because sibling tasks journaled in between. Identical task names can't
 *      collide and a mid-sprint rename can't orphan a task's earlier sections.
 *   3. The most-recent OTHER-task sections that fit a TOKEN BUDGET scaled to the resolved provider
 *      context window (200K vs 1M). A bigger window inlines more cross-task history; a smaller one
 *      stays tight. At least the single most-recent sibling always rides. Older siblings are elided.
 *
 * Elision is NEVER silent: each dropped run is replaced in place by a one-line note stating how many
 * sections were omitted and that the full `progress.md` on disk (reachable via the `sprintDir`
 * `--add-dir` mount) holds the complete history. Lifecycle / recovery breadcrumbs (status separators,
 * quarantine pointers) found in dropped sections are PINNED into the always-kept header band, so the
 * inlined window never silently drops a lifecycle or recovery note.
 *
 * The cap bounds what is *inlined*, never what is *recorded*. Pure — no I/O.
 */

/** Rough chars-per-token for English + markdown — the heuristic the harness uses for excerpt budgets. */
const CHARS_PER_TOKEN = 4;
/** Fraction of the resolved context window the inlined sibling excerpt may occupy. */
const PROGRESS_BUDGET_FRACTION = 0.04;
/** Context window assumed for an unknown / unset model — the smaller (200K) tier, so the default stays tight. */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Floor so even a tiny window keeps a couple of recent siblings. */
const MIN_RECENT_BUDGET_TOKENS = 1_500;

/**
 * Token budget for the recent OTHER-task sibling excerpt, scaled to a model's resolved context
 * window. Unknown / unset models fall back to the 200K tier — a sane, bounded default.
 *
 * @public
 */
export const progressCapBudgetForModel = (model: string | undefined): number => {
  const window = contextWindowFor(model) ?? DEFAULT_CONTEXT_WINDOW;
  return Math.max(MIN_RECENT_BUDGET_TOKENS, Math.round(window * PROGRESS_BUDGET_FRACTION));
};

/** Default sibling budget when no model is resolvable — the 200K tier. */
export const DEFAULT_RECENT_BUDGET_TOKENS = progressCapBudgetForModel(undefined);

const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const elisionNote = (droppedCount: number): string =>
  `_${String(droppedCount)} earlier attempt section${droppedCount === 1 ? '' : 's'} omitted from this inline excerpt — read the full \`progress.md\` on disk for the complete history._\n\n`;

interface CapProgressOptions {
  /**
   * Stable id of the task whose sections ride in full (the depth guarantee). Match is on the id
   * token at the end of each section's header line, never the name. `undefined` in the planning
   * phase (no current task) — then only the recent-siblings token bound applies.
   */
  readonly currentTaskId?: string;
  /**
   * Token budget for the recent OTHER-task sibling sections. Defaults to
   * {@link DEFAULT_RECENT_BUDGET_TOKENS}. Derive from a model via {@link progressCapBudgetForModel}.
   */
  readonly recentBudgetTokens?: number;
}

/**
 * Cap `body` to its header band, ALL sections of `currentTaskId` (when supplied), and the most-recent
 * OTHER-task sections that fit `recentBudgetTokens`. Empty / whitespace-only input returns the empty
 * string. A body already within the cap is returned unchanged. Each elided run of sections is replaced
 * in place by a one-line note naming the omitted count, and any lifecycle / recovery breadcrumb in a
 * dropped section is pinned into the header band.
 *
 * @public
 */
/**
 * Indexes of the OTHER-task sections to keep: walk most-recent-first, keeping a contiguous run while
 * it fits the token budget. The single most-recent sibling always rides even if it alone exceeds the
 * budget, so the generator never loses the latest cross-task context.
 */
const keptSiblingIndexes = (
  sections: readonly string[],
  isCurrent: (section: string) => boolean,
  budget: number
): Set<number> => {
  const otherIndexes = sections.flatMap((s, i) => (isCurrent(s) ? [] : [i]));
  const kept = new Set<number>();
  let used = 0;
  for (let k = otherIndexes.length - 1; k >= 0; k -= 1) {
    const i = otherIndexes[k] ?? 0;
    const cost = estimateTokens(sections[i] ?? '');
    if (kept.size > 0 && used + cost > budget) break;
    kept.add(i);
    used += cost;
  }
  return kept;
};

/**
 * Reassemble the capped body in original order: the header band (with pinned breadcrumbs from dropped
 * sections), the kept sections, and one elision note per maximal dropped run.
 */
const reassemble = (headerBand: string, sections: readonly string[], keep: (i: number) => boolean): string => {
  const droppedBreadcrumbs = sections.flatMap((s, i) => (keep(i) ? [] : extractLifecycleBreadcrumbs(s)));
  const parts: string[] = [headerBand + renderBreadcrumbBand(droppedBreadcrumbs)];
  let droppedRun = 0;
  for (let i = 0; i < sections.length; i += 1) {
    if (!keep(i)) {
      droppedRun += 1;
      continue;
    }
    if (droppedRun > 0) {
      parts.push(elisionNote(droppedRun));
      droppedRun = 0;
    }
    parts.push(sections[i] ?? '');
  }
  if (droppedRun > 0) parts.push(elisionNote(droppedRun));
  return parts.join('');
};

export const capProgressBody = (body: string, options: CapProgressOptions = {}): string => {
  if (body.trim().length === 0) return '';

  const { headerBand, sections } = splitJournal(body);
  if (sections.length === 0) return body; // header-only — return as-is.

  const budget = options.recentBudgetTokens ?? DEFAULT_RECENT_BUDGET_TOKENS;
  // Depth guarantee: the current task's own sections are always kept, wherever they sit.
  const isCurrent = (section: string): boolean =>
    options.currentTaskId !== undefined && sectionBelongsToTask(section, options.currentTaskId);

  const keptOther = keptSiblingIndexes(sections, isCurrent, budget);
  const keep = (i: number): boolean => isCurrent(sections[i] ?? '') || keptOther.has(i);
  if (sections.every((_s, i) => keep(i))) return body; // already within the cap — untouched.

  return reassemble(headerBand, sections, keep);
};
