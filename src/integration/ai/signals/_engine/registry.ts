import type { HarnessSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { agentsMdParser } from '@src/integration/ai/signals/agents-md/parser.ts';
import { changeParser } from '@src/integration/ai/signals/change/parser.ts';
import { commitMessageParser } from '@src/integration/ai/signals/commit-message/parser.ts';
import { decisionParser } from '@src/integration/ai/signals/decision/parser.ts';
import { evaluationParser } from '@src/integration/ai/signals/evaluation/parser.ts';
import { learningParser } from '@src/integration/ai/signals/learning/parser.ts';
import { noteParser } from '@src/integration/ai/signals/note/parser.ts';
import { progressParser } from '@src/integration/ai/signals/progress/parser.ts';
import { progressEntryParser } from '@src/integration/ai/signals/progress-entry/parser.ts';
import { setupScriptParser } from '@src/integration/ai/signals/setup-script/parser.ts';
import { setupSkillParser } from '@src/integration/ai/signals/setup-skill/parser.ts';
import { taskBlockedParser } from '@src/integration/ai/signals/task-blocked/parser.ts';
import { taskCompleteParser } from '@src/integration/ai/signals/task-complete/parser.ts';
import { taskVerifiedParser } from '@src/integration/ai/signals/task-verified/parser.ts';
import { verifyScriptParser } from '@src/integration/ai/signals/verify-script/parser.ts';
import { verifySkillParser } from '@src/integration/ai/signals/verify-skill/parser.ts';
import type { SignalParser } from '@src/integration/ai/signals/_engine/parser-types.ts';

/**
 * Default parser registry. Order is irrelevant for correctness — the merged stream is
 * re-sorted by document index — but listing them logically (verdicts → state → narrative →
 * pinned → setup-time proposals) makes it easier to scan when adding a new tag.
 */
export const DEFAULT_SIGNAL_PARSERS: readonly SignalParser[] = [
  // verdicts
  evaluationParser,
  taskCompleteParser,
  taskVerifiedParser,
  taskBlockedParser,
  // narrative / inline
  progressParser,
  progressEntryParser,
  noteParser,
  changeParser,
  // pinned cross-task knowledge (decisions + learnings)
  learningParser,
  decisionParser,
  // generator → harness handover
  commitMessageParser,
  // setup-time proposals (detect-scripts / detect-skills / readiness)
  setupScriptParser,
  verifyScriptParser,
  setupSkillParser,
  verifySkillParser,
  agentsMdParser,
];

/**
 * Run every parser over `text`, collect their matches, and return the resulting signals in
 * document order. Pure — does not mutate the input or the parser list.
 *
 * Nested-tag suppression: when a tag's pair body contains the literal text of another tag
 * (e.g. a literal `<task-complete>` quoted inside a `<task-verified>output</task-verified>`),
 * the inner match is dropped. After sorting by document position, any match whose range is
 * fully contained within a previously-accepted match's range is suppressed. This preserves
 * the v1 "outer tag consumes its body" semantic without coupling the parsers to each other.
 */
export const runSignalParsers = (
  text: string,
  timestamp: IsoTimestamp,
  parsers: readonly SignalParser[] = DEFAULT_SIGNAL_PARSERS
): readonly HarnessSignal[] => {
  const merged = parsers.flatMap((p) => p.parse(text, timestamp));
  merged.sort((a, b) => a.index - b.index || b.length - a.length);
  const accepted: typeof merged = [];
  for (const m of merged) {
    const enclosingIndex = accepted.findIndex(
      (acc) => acc.index <= m.index && m.index + m.length <= acc.index + acc.length && acc !== m
    );
    if (enclosingIndex === -1) accepted.push(m);
  }
  return accepted.map((m) => m.signal);
};
