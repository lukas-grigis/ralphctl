/**
 * `checkAgentDefinitionQuality` — a pure, non-blocking scanner that flags agent-definition
 * bodies too vague to give an AI session concrete guidance.
 *
 * Operator-authored agent definitions land directly in a provider's native sub-agent directory
 * and get delegated to as-is, so a definition that is all mood and no method (short, no
 * structure, or — for an evaluator-role definition — no mention of how to actually verify
 * anything) quietly produces a sub-agent that can't do its job. This module is the single
 * source of truth for that quality bar. It is deliberately I/O-free so two callers can share it:
 * a future contract test over the bundled set, and {@link warnIfVague} (the operator-source warn
 * path).
 *
 * Mirrors the shape of `skills/_engine/skill-contract-checker.ts` (checkers + a warn helper),
 * but the concern is different: that module blocks HARNESS-BREAKING instructions; this one flags
 * LOW-QUALITY (but harmless) guidance. Neither check ever fails the read — both are advisory.
 */

import type { Logger } from '@src/business/observability/logger.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';

/** One quality concern, with enough context for a human to judge it. */
export interface AgentDefinitionQualityConcern {
  /** Rule id (`Q1`…`Q3`). */
  readonly rule: string;
  /** Human-readable explanation of what's missing and why it matters. */
  readonly description: string;
}

/** Result of scanning one agent definition. `pass` is `concerns.length === 0`. */
export interface AgentDefinitionQualityReport {
  readonly name: string;
  readonly concerns: readonly AgentDefinitionQualityConcern[];
  readonly pass: boolean;
}

/** Below this word count a body reads as filler rather than actionable guidance. */
const MIN_WORD_COUNT = 40;

/** A Markdown heading or an ordered/unordered list item — the minimal sign of concrete structure. */
const HEADING_OR_LIST = /^(?:#{1,6}\s|\s*(?:\d+[.)]|[-*+])\s)/mu;

/** Terms in the name/description that suggest this definition plays an evaluator/reviewer role. */
const EVALUATOR_HINTS = ['evaluat', 'review', 'judge', 'grade'] as const;

/** Concrete verification vocabulary an evaluator-role body should mention at least once. */
const VERIFICATION_TERMS = ['verif', 'criteri', 'test', 'evidence', 'pass', 'fail', 'command', 'check'] as const;

const wordCount = (text: string): number =>
  text
    .trim()
    .split(/\s+/u)
    .filter((w) => w.length > 0).length;

interface Checker {
  readonly id: string;
  readonly description: string;
  /** Returns `true` when the concern is present. */
  readonly flags: (definition: AgentDefinition) => boolean;
}

const CHECKERS: readonly Checker[] = [
  {
    id: 'Q1',
    description: `body is under ${String(MIN_WORD_COUNT)} words — too short to give concretely actionable guidance`,
    flags: (d) => wordCount(d.content) < MIN_WORD_COUNT,
  },
  {
    id: 'Q2',
    description: 'body has no headings or list items — reads as unstructured prose rather than concrete steps',
    flags: (d) => !HEADING_OR_LIST.test(d.content),
  },
  {
    id: 'Q3',
    description:
      'an evaluator-role definition never mentions verification, criteria, or evidence — guidance is not concretely checkable',
    flags: (d) => {
      const identity = `${d.name} ${d.description}`.toLowerCase();
      const looksLikeEvaluator = EVALUATOR_HINTS.some((hint) => identity.includes(hint));
      if (!looksLikeEvaluator) return false;
      const body = d.content.toLowerCase();
      return !VERIFICATION_TERMS.some((term) => body.includes(term));
    },
  },
];

/**
 * Scan `definition` against the quality checkers.
 *
 * @public
 */
export const checkAgentDefinitionQuality = (definition: AgentDefinition): AgentDefinitionQualityReport => {
  const concerns = CHECKERS.filter((checker) => checker.flags(definition)).map((checker) => ({
    rule: checker.id,
    description: checker.description,
  }));
  return { name: definition.name, concerns, pass: concerns.length === 0 };
};

/**
 * Operator-definition warn path: log one warn-level line per quality concern. Never throws — a
 * vague operator definition should degrade to a warning, not block install.
 *
 * @public
 */
export const warnIfVague = (logger: Logger, definition: AgentDefinition): void => {
  const report = checkAgentDefinitionQuality(definition);
  for (const concern of report.concerns) {
    logger.warn('agent definition quality concern', {
      name: definition.name,
      rule: concern.rule,
      description: concern.description,
    });
  }
};
