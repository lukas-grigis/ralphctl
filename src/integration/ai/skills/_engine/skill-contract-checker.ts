/**
 * `checkSkillContract` — a pure, line-by-line scanner that flags SKILL.md content which would
 * subvert a harness mechanism if the AI session followed it as an instruction.
 *
 * Bundled posture skills and operator-authored skills both land in the AI session's native
 * skills directory and are auto-mounted, so a skill that tells the AI to (say) `git commit` or
 * "write the result to result.json" can silently break the harness's invariants: the file-based
 * signal contract (signals.json at outputDir), harness-owned git, one-PR-per-sprint, the
 * attribution-aware verify gate, ecosystem-agnosticism, controlled delegation.
 *
 * This module is the single source of truth for those six rules (S1–S6). It is deliberately
 * I/O-free and free of outer-layer imports so two callers can share it: the contract test
 * (asserts every bundled skill passes) and {@link warnIfContractViolated} (an operator-skill
 * warn path). The {@link Logger} type is a business-layer port — integration may import inward.
 *
 * ## Scanning model
 *
 * Each line is classified before any rule runs:
 *   - A fenced code block is tracked with an `inCodeFence` flag toggled by ``` fences. Lines
 *     inside a fence are always treated as imperative (a code block is literal instruction).
 *   - Outside a fence, a line counts as an imperative instruction only when it begins with a
 *     list marker — an ordered item (`1.` / `2)`) or an unordered item (`- `). Free prose is
 *     descriptive, not directive, and is skipped to keep false-positives low.
 *   - A blockquote line (`>`) is always skipped: posture skills quote their source material and
 *     anti-pattern prose verbatim, which is description, not direction.
 *   - A negation keyword (`do not` / `don't` / `never` / `avoid` / `must not`) appearing before a
 *     forbidden pattern on the same line DEMOTES that pattern: "never open a separate PR" is
 *     good advice, not a violation. Anti-pattern prose is the whole point of a posture skill.
 */

import type { Logger } from '@src/business/observability/logger.ts';

/** One failed contract rule, with enough context for a human to locate and judge it. */
export interface SkillViolation {
  /** Rule id (`S1`…`S6`) — names the harness mechanism the rule protects. */
  readonly rule: string;
  /** Human-readable explanation of what the line directs and why it is forbidden. */
  readonly description: string;
  /** The offending text, clipped to ≤120 chars so a log line stays readable. */
  readonly evidence: string;
  /** 1-based line number in the scanned content. */
  readonly lineNumber: number;
}

/** Result of scanning one SKILL.md body. `pass` is `violations.length === 0`. */
export interface SkillContractReport {
  readonly skillName: string;
  readonly violations: readonly SkillViolation[];
  readonly pass: boolean;
}

const MAX_EVIDENCE = 120;

const NEGATION_KEYWORDS = ['do not', "don't", 'never', 'avoid', 'must not'] as const;

/**
 * True when a forbidden pattern at `matchIndex` is preceded (on the same line) by a negation
 * keyword — i.e. the line is anti-pattern prose ("never run `git push`"), not a directive.
 * Only negations BEFORE the pattern demote it; "push, never to main" would not (and should not)
 * be demoted because the imperative still stands.
 */
const isNegated = (lowerLine: string, matchIndex: number): boolean => {
  const before = lowerLine.slice(0, matchIndex);
  return NEGATION_KEYWORDS.some((kw) => before.includes(kw));
};

/** Clip evidence to a single readable line. */
const clip = (line: string): string => {
  const collapsed = line.trim().replace(/\s+/gu, ' ');
  return collapsed.length <= MAX_EVIDENCE ? collapsed : `${collapsed.slice(0, MAX_EVIDENCE - 1)}…`;
};

/**
 * Each rule is a matcher run against the lowercased, instruction-classified line. A matcher
 * returns the index of the forbidden token (for negation-demotion) or `-1` when the line is
 * clean for that rule.
 */
interface Rule {
  readonly id: string;
  readonly description: string;
  readonly match: (lowerLine: string) => number;
}

/** First index at which any of `needles` occurs in `haystack`, else -1. */
const firstIndexOf = (haystack: string, needles: readonly string[]): number => {
  let best = -1;
  for (const needle of needles) {
    const idx = haystack.indexOf(needle);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
};

// S1 — output-channel hijack. The AI must emit structured output ONLY as signals.json at
// outputDir; any instruction to route a result to another file / stdout / a custom schema
// breaks the file-based signal contract the harness reads post-spawn.
const S1_OUTPUT_PATTERNS = [
  'write result to',
  'write the result to',
  'write results to',
  'write the results to',
  'write your result to',
  'write your output to',
  'write output to',
  'save the result to',
  'save results to',
  'output json to',
  'print json to stdout',
  'print the json to stdout',
  'emit json to stdout',
  'write json to',
  'custom output schema',
  'define your own output schema',
] as const;

// S2 — git mutation. Orientation reads (git log / git status / git diff) are fine; anything that
// rewrites the tree or history is harness-owned.
const S2_GIT_MUTATIONS = [
  'git commit',
  'git branch',
  'git checkout',
  'git merge',
  'git cherry-pick',
  'git cherry pick',
  'git push',
  'git tag',
  'git rebase',
  'git reset',
] as const;

// S3 — separate-PR / branch-per-change. One sprint lands as one PR; advising the AI to split work
// across PRs or branches breaks that.
const S3_PR_PATTERNS = [
  'separate pr',
  'separate pull request',
  'new pull request',
  'open a pr',
  'open a pull request',
] as const;

// S4 — package-manager command literals as unconditional instructions. Downstream ecosystems
// differ; concrete commands belong in {{PROJECT_TOOLING}}, never baked into a skill.
const S4_PM_COMMANDS = [
  'pnpm install',
  'pnpm run',
  'pnpm test',
  'pnpm add',
  'npm install',
  'npm run',
  'npm test',
  'npm ci',
  'yarn install',
  'yarn add',
  'pip install',
  'cargo build',
  'cargo test',
  'cargo run',
  'go test',
  'go build',
  'go run',
] as const;

// S5 — uncontrolled delegation. The AI must not spin up its own subagents or fresh provider
// sessions; delegation goes only through the harness's declared mechanisms.
const S5_SUBAGENT_PATTERNS = [
  'spawn a subagent',
  'spawn subagent',
  'spawn an agent',
  'launch a subagent',
  'launch a new agent',
  'start a new session',
  'start a subagent',
  'spawn a new session',
  'create a subagent',
  'delegate to a subagent',
] as const;

// S6 — self-owned verify verdict. The post-task verify gate (attribution-aware) owns the done
// verdict; a skill must not tell the AI it owns the green build. Incremental "run narrow checks
// after each change" is explicitly allowed and must NOT trip this rule.
const S6_SELF_GATE_PATTERNS = [
  'run the full suite and make sure it passes before signalling done',
  'run the full suite and make sure it passes before signaling done',
  'run the full test suite before signalling done',
  'run the full test suite before signaling done',
  'you own the green build',
  'you are responsible for the green build',
  'make sure the full suite passes before you signal',
  'ensure the entire suite passes before signalling',
  'ensure the entire suite passes before signaling',
] as const;

const RULES: readonly Rule[] = [
  {
    id: 'S1',
    description:
      'directs structured output to a channel other than signals.json at outputDir — breaks the file-based signal contract',
    match: (line) => firstIndexOf(line, S1_OUTPUT_PATTERNS),
  },
  {
    id: 'S2',
    description: 'instructs a git mutation command — git history/tree is harness-owned',
    match: (line) => firstIndexOf(line, S2_GIT_MUTATIONS),
  },
  {
    id: 'S3',
    description: 'advises a separate PR / branch-per-change — breaks one-PR-per-sprint',
    match: (line) => firstIndexOf(line, S3_PR_PATTERNS),
  },
  {
    id: 'S4',
    description: 'hardcodes a package-manager command literal — breaks ecosystem-agnosticism (use {{PROJECT_TOOLING}})',
    match: (line) => firstIndexOf(line, S4_PM_COMMANDS),
  },
  {
    id: 'S5',
    description:
      'instructs spawning a subagent / new provider session outside declared mechanisms — breaks controlled delegation',
    match: (line) => firstIndexOf(line, S5_SUBAGENT_PATTERNS),
  },
  {
    id: 'S6',
    description: 'claims the AI self-owns the post-task verify verdict — breaks the attribution-aware gate',
    match: (line) => firstIndexOf(line, S6_SELF_GATE_PATTERNS),
  },
];

const CODE_FENCE = /^\s*(```|~~~)/u;
const BLOCKQUOTE = /^\s*>/u;
const LIST_MARKER = /^\s*(?:\d+[.)]|[-*+])\s/u;

/**
 * Scan SKILL.md `content` against the six harness-compatibility rules.
 *
 * @param skillName folder / frontmatter name, echoed back for caller correlation.
 * @param content   raw SKILL.md body (frontmatter or not — frontmatter lines are harmless prose).
 * @returns a {@link SkillContractReport}; `pass` is true iff no rule tripped.
 * @public
 */
export const checkSkillContract = (skillName: string, content: string): SkillContractReport => {
  const violations: SkillViolation[] = [];
  const lines = content.split('\n');
  let inCodeFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    // Toggle the fence flag on a fence line, but never scan the fence delimiter itself.
    if (CODE_FENCE.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }

    // Blockquotes are quoted prose (source material, anti-pattern examples) — never directive.
    if (!inCodeFence && BLOCKQUOTE.test(line)) continue;

    // A line is an instruction when it is fenced code OR an ordered/unordered list item.
    const isInstruction = inCodeFence || LIST_MARKER.test(line);
    if (!isInstruction) continue;

    const lowerLine = line.toLowerCase();
    for (const rule of RULES) {
      const matchIndex = rule.match(lowerLine);
      if (matchIndex === -1) continue;
      if (isNegated(lowerLine, matchIndex)) continue; // anti-pattern prose — demoted.
      violations.push({
        rule: rule.id,
        description: rule.description,
        evidence: clip(line),
        lineNumber: i + 1,
      });
    }
  }

  return { skillName, violations, pass: violations.length === 0 };
};

/**
 * Operator-skill warn path: log one warn-level line per contract violation. Never throws — a
 * malformed operator skill should degrade to a warning, not crash the flow. Bundled skills are
 * gated by the contract test instead, so this fires only for user-authored skills at install time.
 *
 * @public
 */
export const warnIfContractViolated = (logger: Logger, skillName: string, content: string): void => {
  const report = checkSkillContract(skillName, content);
  for (const v of report.violations) {
    logger.warn('skill contract violation', {
      skill: skillName,
      rule: v.rule,
      line: v.lineNumber,
      description: v.description,
      evidence: v.evidence,
    });
  }
};
