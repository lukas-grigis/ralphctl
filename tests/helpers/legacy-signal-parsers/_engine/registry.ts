import type { HarnessSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { agentsMdParser } from '@tests/helpers/legacy-signal-parsers/agents-md/parser.ts';
import { changeParser } from '@tests/helpers/legacy-signal-parsers/change/parser.ts';
import { commitMessageParser } from '@tests/helpers/legacy-signal-parsers/commit-message/parser.ts';
import { decisionParser } from '@tests/helpers/legacy-signal-parsers/decision/parser.ts';
import { evaluationParser } from '@tests/helpers/legacy-signal-parsers/evaluation/parser.ts';
import { learningParser } from '@tests/helpers/legacy-signal-parsers/learning/parser.ts';
import { noteParser } from '@tests/helpers/legacy-signal-parsers/note/parser.ts';
import { progressParser } from '@tests/helpers/legacy-signal-parsers/progress/parser.ts';
import { progressEntryParser } from '@tests/helpers/legacy-signal-parsers/progress-entry/parser.ts';
import { setupScriptParser } from '@tests/helpers/legacy-signal-parsers/setup-script/parser.ts';
import { setupSkillParser } from '@tests/helpers/legacy-signal-parsers/setup-skill/parser.ts';
import { taskBlockedParser } from '@tests/helpers/legacy-signal-parsers/task-blocked/parser.ts';
import { taskCompleteParser } from '@tests/helpers/legacy-signal-parsers/task-complete/parser.ts';
import { taskVerifiedParser } from '@tests/helpers/legacy-signal-parsers/task-verified/parser.ts';
import { verifyScriptParser } from '@tests/helpers/legacy-signal-parsers/verify-script/parser.ts';
import { verifySkillParser } from '@tests/helpers/legacy-signal-parsers/verify-skill/parser.ts';
import type { SignalParser } from '@tests/helpers/legacy-signal-parsers/_engine/parser-types.ts';

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
