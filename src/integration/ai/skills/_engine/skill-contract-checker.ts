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
 * This module is the single source of truth for those eight rules (S1–S8). It is deliberately
 * I/O-free and free of outer-layer imports so two callers can share it: the contract test
 * (asserts every bundled skill passes) and {@link warnIfContractViolated} (an operator-skill
 * warn path). The {@link Logger} type is a business-layer port — integration may import inward.
 *
 * ## Scanning model
 *
 * This classification governs S1–S6, the imperative-command rules. Each line is classified
 * before any of those rules runs:
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
 *
 * S7 (angle-bracket signal tag syntax) and S8 (template placeholders) are deliberately NOT gated
 * by this classification: each is a syntax mistake with no legitimate line shape, so
 * `checkSkillContract` runs them against every line (prose, list continuation lines, blockquotes,
 * fenced content) except the fence delimiter itself. Negation demotion still applies to S7 but not
 * to S8 — "never hardcode commands, use {{X}}" is exactly the shape S8 exists to catch.
 *
 * A skill is a folder, so callers scan every Markdown document in it: {@link skillContractDocuments}
 * lists `SKILL.md` and each Markdown support file under its own name.
 */

import type { Logger } from '@src/business/observability/logger.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';

/** One failed contract rule, with enough context for a human to locate and judge it. */
export interface SkillViolation {
  /** Rule id (`S1`…`S8`) — names the harness mechanism the rule protects. */
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
  /** Receives the lowercased line, or the original line when {@link Rule.caseSensitive} is set. */
  readonly match: (line: string) => number;
  /** Match against the original casing (S8 keys on UPPER_SNAKE placeholder names). */
  readonly caseSensitive?: boolean;
  /** When false, a preceding negation does not demote a match. Defaults to true. */
  readonly negatable?: boolean;
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

// S4 — package-manager / build-tool command literals as unconditional instructions. Downstream
// ecosystems differ; a skill names the step generically ("run the project's test command") and the
// harness supplies the real commands in the prompt. Matched on a word boundary (see S4_PM_REGEX).
const S4_PM_COMMANDS = [
  'pnpm install',
  'pnpm run',
  'pnpm test',
  'pnpm add',
  'npm install',
  'npm run',
  'npm test',
  'npm ci',
  'pnpm exec',
  'pnpm dlx',
  'yarn install',
  'yarn add',
  'yarn test',
  'yarn run',
  'yarn build',
  'npx',
  'bunx',
  'bun install',
  'bun run',
  'bun test',
  'bun add',
  'pip install',
  'uv run',
  'uv sync',
  'uv pip',
  'uv add',
  'poetry install',
  'poetry run',
  'poetry add',
  // Bare tool names (`./gradlew`, `mvn`) stay legal: a skill may name a wrapper without running it.
  'mvn test',
  'mvn install',
  'mvn package',
  'mvn verify',
  'gradle build',
  'gradle test',
  'gradlew build',
  'gradlew test',
  'dotnet build',
  'dotnet test',
  'dotnet run',
  'dotnet restore',
  'cargo build',
  'cargo test',
  'cargo run',
  'go test',
  'go build',
  'go run',
] as const;

const escapeRegex = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Bounded on both sides so `go run` doesn't fire inside "ego run" and `mvn` not inside a longer word.
const S4_PM_REGEX = new RegExp(`(?<![a-z0-9_-])(?:${S4_PM_COMMANDS.map(escapeRegex).join('|')})(?![a-z0-9_-])`, 'u');

// S8 — template placeholders. Skill files are installed verbatim; nothing substitutes `{{NAME}}`,
// so the session reads the literal braces. Keyed on the harness's UPPER_SNAKE placeholder shape so
// lowercase view-template syntax in examples (`{{ user.name }}`) stays legal.
const S8_PLACEHOLDER_REGEX = /\{\{\s*[A-Z][A-Z0-9_]*\s*\}\}/u;

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

// S7 — angle-bracket signal tag syntax. The shipped output contract is a single typed
// `signals.json` (a `{type: 'note', ...}` object per entry — see
// `contract/_engine/render-contract-section.ts`); it has no XML/HTML-style tag syntax. A skill
// that tells the AI to "emit `<task-complete>`" or "surface it as a `<note>`" teaches a contract
// the harness never parses — the session would produce a tag nothing reads instead of a signal
// the harness validates.
//
// Unlike S1–S6 (imperative commands, meaningfully gated to instruction lines — free prose about
// `git commit` is merely descriptive), a literal signal tag has no legitimate use on ANY line
// shape: a hard-wrapped bullet's continuation line, a free-prose sentence, or a self-closing
// `<task-complete/>` form all teach the same false contract as a single-line bullet does. So S7
// is NOT gated by `classifyLine`'s instruction test — it is applied to every line by
// `checkSkillContract` directly (see the dedicated loop below) rather than through
// `findViolationsInLine`. The pattern is a word-bounded regex, not exact-literal strings, so it
// catches the opening tag, the closing tag, and the self-closing form, and is anchored on real
// signal-kind names (`src/integration/ai/contract/_engine/signals/*`) rather than only the six
// kinds a past mistake happened to use — `change`, `evaluation`, `commit-message`, and
// `task-plan` are equally real kinds an author could mistype as a tag.
const S7_SIGNAL_TAG_NAMES = [
  'task-complete',
  'task-verified',
  'task-blocked',
  'task-plan',
  'note',
  'decision',
  'learning',
  'change',
  'evaluation',
  'commit-message',
] as const;

// Matches `<name`, `</name`, or the self-closing `<name/` form, bounded on BOTH sides:
//
//   - Right — the tag name is terminated by whitespace, `/`, `>`, or end-of-line, so `<note>`,
//     `</note>`, `<note/>`, and `<note severity="minor">` all match, while a longer identifier
//     that merely starts with a listed name (`<decision-tree>`) does not: the character after
//     `decision` there is `-`, not a boundary.
//   - Left — the `<` must not follow an identifier character, so generic type syntax
//     (`Array<Change>`, `Set<Note>`, `Promise<Evaluation>`, `List<Change>`) is not a tag. A real
//     tag literal is always preceded by a space, a backtick, or the start of the line, so the
//     lookbehind drops the generics without losing a single genuine catch. The scan runs on the
//     lowercased line, so only the lowercase half of the class can ever fire — the full class is
//     spelled out anyway so the pattern reads correctly on its own.
const S7_SIGNAL_TAG_REGEX = new RegExp(`(?<![A-Za-z0-9_])<\\/?(?:${S7_SIGNAL_TAG_NAMES.join('|')})(?=[\\s/>]|$)`, 'u');

/** S7's matcher: the index of the first angle-bracket signal tag in `lowerLine`, else -1. */
const matchSignalTag = (lowerLine: string): number => S7_SIGNAL_TAG_REGEX.exec(lowerLine)?.index ?? -1;

const S8_RULE: Rule = {
  id: 'S8',
  description:
    'contains a `{{PLACEHOLDER}}` — skill files are installed verbatim and never substituted, so the session sees the literal braces; describe the step in plain words instead',
  match: (line) => S8_PLACEHOLDER_REGEX.exec(line)?.index ?? -1,
  caseSensitive: true,
  negatable: false,
};

const S7_RULE: Rule = {
  id: 'S7',
  description:
    'instructs emitting an angle-bracket signal tag (e.g. `<task-complete>`) — the real contract is a typed signals.json object, not an XML/HTML-style tag',
  match: matchSignalTag,
};

// S1–S6: imperative-command rules, gated to instruction lines (fenced code or a list item) by
// `classifyLine` — see the module doc for why that gate is right for these six but wrong for S7.
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
    description:
      'hardcodes a package-manager / build-tool command — breaks ecosystem-agnosticism; name the step generically ("run the project\'s test command") and let the prompt supply the real command',
    match: (line) => S4_PM_REGEX.exec(line)?.index ?? -1,
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

/** Line classification result: the fence flag carried forward, and whether the line is directive. */
interface LineClassification {
  readonly inCodeFence: boolean;
  readonly isInstruction: boolean;
}

/**
 * Classify one line against the scanning model documented at the top of this module: a fence
 * delimiter toggles `inCodeFence` and is never itself scanned; a blockquote outside a fence is
 * always descriptive; everything else counts as an instruction only when fenced code or an
 * ordered/unordered list item.
 */
const classifyLine = (line: string, inCodeFence: boolean): LineClassification => {
  // Toggle the fence flag on a fence line, but never scan the fence delimiter itself.
  if (CODE_FENCE.test(line)) return { inCodeFence: !inCodeFence, isInstruction: false };

  // Blockquotes are quoted prose (source material, anti-pattern examples) — never directive.
  if (!inCodeFence && BLOCKQUOTE.test(line)) return { inCodeFence, isInstruction: false };

  // A line is an instruction when it is fenced code OR an ordered/unordered list item.
  return { inCodeFence, isInstruction: inCodeFence || LIST_MARKER.test(line) };
};

/** Run `rules` against one line, returning the violations it trips (if any). */
const findViolationsInLine = (line: string, lineNumber: number, rules: readonly Rule[]): readonly SkillViolation[] => {
  const lowerLine = line.toLowerCase();
  const violations: SkillViolation[] = [];
  for (const rule of rules) {
    const matchIndex = rule.match(rule.caseSensitive === true ? line : lowerLine);
    if (matchIndex === -1) continue;
    if (rule.negatable !== false && isNegated(lowerLine, matchIndex)) continue; // anti-pattern prose — demoted.
    violations.push({ rule: rule.id, description: rule.description, evidence: clip(line), lineNumber });
  }
  return violations;
};

/**
 * Scan one Markdown document of a skill against the eight harness-compatibility rules.
 *
 * @param skillName folder / frontmatter name, echoed back for caller correlation.
 * @param content   raw SKILL.md body (frontmatter or not — frontmatter lines are harmless prose).
 * @returns a {@link SkillContractReport}; `pass` is true iff no rule tripped.
 */
export const checkSkillContract = (skillName: string, content: string): SkillContractReport => {
  const violations: SkillViolation[] = [];
  const lines = content.split('\n');
  let inCodeFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const classified = classifyLine(line, inCodeFence);
    inCodeFence = classified.inCodeFence;
    const lineNumber = i + 1;

    // S7 is a syntax rule, not an imperative-command rule: it runs on every line except a fence
    // delimiter itself (never on the ``` line, but yes on the prose/continuation/fenced-content
    // lines classifyLine would otherwise skip for S1–S6). See the S7 comment above for why.
    if (!CODE_FENCE.test(line)) {
      violations.push(...findViolationsInLine(line, lineNumber, [S7_RULE, S8_RULE]));
    }

    if (!classified.isInstruction) continue;

    violations.push(...findViolationsInLine(line, lineNumber, RULES));
  }

  return { skillName, violations, pass: violations.length === 0 };
};

/** One Markdown document of a skill folder, named for log / report correlation. */
export interface SkillContractDocument {
  readonly name: string;
  readonly content: string;
}

/** Every document the contract covers: `SKILL.md` as `<name>`, then each `.md` support file as `<name>/<path>`. */
export const skillContractDocuments = (
  skill: Pick<Skill, 'name' | 'content' | 'files'>
): readonly SkillContractDocument[] => [
  { name: skill.name, content: skill.content },
  ...(skill.files ?? []).flatMap((f) =>
    f.path.endsWith('.md') && typeof f.content === 'string'
      ? [{ name: `${skill.name}/${f.path}`, content: f.content }]
      : []
  ),
];

/**
 * Operator-skill warn path: log one warn-level line per contract violation. Never throws — a
 * malformed operator skill should degrade to a warning, not crash the flow. Bundled skills are
 * gated by the contract test instead, so this fires only for user-authored skills at install time.
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
