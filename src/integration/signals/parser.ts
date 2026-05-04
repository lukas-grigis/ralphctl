/**
 * `SignalParser` — concrete `SignalParserPort` implementation.
 *
 * Walks the raw AI agent stdout once per known tag, builds typed
 * `HarnessSignal`s, and emits them in **source order** — the order they
 * appear in the input. The legacy parser emitted in fixed type-group order;
 * the dashboard wants a faithful timeline so we sort by match index here.
 *
 * Pure (no I/O, no instance state across `parse` calls). Total — malformed
 * inner content is dropped silently. Timestamps are injected via `opts.now`
 * so tests can pin time deterministically.
 */
import type {
  ParseWithDiagnosticsResult,
  SignalParseDiagnostic,
  SignalParserPort,
} from '@src/business/ports/signal-parser-port.ts';
import {
  type AgentsMdProposalSignal,
  type CheckScriptDiscoverySignal,
  type DimensionScore,
  type DimensionScoreValue,
  type EvaluationSignal,
  type HarnessSignal,
  type NoteSignal,
  type ProgressSignal,
  type SetupScriptSignal,
  type SkillSuggestionsSignal,
  type TaskBlockedSignal,
  type TaskCompleteSignal,
  type TaskVerifiedSignal,
  type VerifyScriptSignal,
} from '@src/domain/signals/harness-signal.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';

/**
 * Each entry below is constructed *fresh* per `parse()` call to avoid
 * leaking `lastIndex` state across invocations. Capture-group meanings are
 * documented inline.
 */
function buildPatterns(): {
  progress: RegExp;
  evaluationFailed: RegExp;
  taskVerified: RegExp;
  taskComplete: RegExp;
  taskBlocked: RegExp;
  note: RegExp;
  checkScript: RegExp;
  agentsMd: RegExp;
  setupScript: RegExp;
  verifyScript: RegExp;
  skillSuggestions: RegExp;
  evaluationPassed: RegExp;
  dimension: RegExp;
} {
  return {
    progress: /<progress>([\s\S]*?)<\/progress>/g,
    // Tag-only marker — no inner content.
    evaluationPassed: /<evaluation-passed>/g,
    evaluationFailed: /<evaluation-failed>([\s\S]*?)<\/evaluation-failed>/g,
    taskVerified: /<task-verified>([\s\S]*?)<\/task-verified>/g,
    taskComplete: /<task-complete>/g,
    taskBlocked: /<task-blocked>([\s\S]*?)<\/task-blocked>/g,
    note: /<note>([\s\S]*?)<\/note>/g,
    checkScript: /<check-script>([\s\S]*?)<\/check-script>/g,
    agentsMd: /<agents-md>([\s\S]*?)<\/agents-md>/g,
    setupScript: /<setup-script>([\s\S]*?)<\/setup-script>/g,
    verifyScript: /<verify-script>([\s\S]*?)<\/verify-script>/g,
    skillSuggestions: /<skill-suggestions>([\s\S]*?)<\/skill-suggestions>/g,
    // Format: `**Name** (score 1-5): N — finding`
    // The annotation label `(score 1-5)` is literal; N is the numeric score.
    // Group 1: dimension name, Group 2: score digit (1–5), Group 3: finding text.
    dimension: /\*\*([A-Za-z][A-Za-z0-9 ]{0,38})\*\*\s+\(score\s+1-5\)\s*:\s*([1-5])\s*(?:—|-)\s*(.+)/gi,
  };
}

/**
 * Denylist of obviously-hostile shapes for AI-discovered check scripts —
 * matches pipe-to-shell, `curl ... | sh`, `wget -O- | sh`, `eval`, and
 * `rm -rf`. Hits drop the signal silently so the setup flow falls through
 * to manual input rather than seeding an exec-able default.
 */
const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  /\|\s*(ba)?sh\b/,
  /\bcurl\b[^|;&\n]*\|/,
  /\bwget\b[^|;&\n]*(-O-|--output-document=-)[^|;&\n]*\|/,
  /\beval\b/,
  /\brm\s+-[rf]+\b/,
];

function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(command));
}

/**
 * Compute the mean of all dimension scores, rounded to one decimal place.
 * Returns `undefined` when the list is empty.
 */
function computeOverallScore(scores: readonly DimensionScore[]): number | undefined {
  if (scores.length === 0) return undefined;
  const total = scores.reduce((sum, d) => sum + d.score, 0);
  return Math.round((total / scores.length) * 10) / 10;
}

/**
 * Find every dimension line in the input, lowercase the name, and dedupe
 * by first occurrence. The lowercase-at-the-boundary discipline is the
 * reason this adapter exists — the domain treats `EvaluationDimension` as
 * free-form text.
 *
 * The new format is `**Name** (score 1-5): N — finding`.
 * Group 1 = name, Group 2 = numeric score, Group 3 = finding.
 * Lines that do not include the score annotation are silently skipped — the
 * evaluator prompt makes the annotation mandatory, so omitting it is a
 * malformed output.
 */
function parseDimensionScores(output: string, dimensionRe: RegExp): DimensionScore[] {
  const scores: DimensionScore[] = [];
  const seen = new Set<string>();
  dimensionRe.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = dimensionRe.exec(output)) !== null) {
    const rawName = match[1];
    const rawScore = match[2];
    const finding = match[3];
    if (rawName === undefined || rawScore === undefined || finding === undefined) continue;
    const name = rawName.trim().toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    const scoreNum = parseInt(rawScore, 10);
    if (scoreNum < 1 || scoreNum > 5) continue;
    const score = scoreNum as DimensionScoreValue;
    scores.push({
      dimension: name,
      score,
      passed: score >= 4,
      finding: finding.trim(),
    });
  }
  return scores;
}

/**
 * Internal `(matchIndex, signal)` pairing used to sort by source position
 * before flattening to the final emission list.
 */
interface IndexedSignal {
  readonly index: number;
  readonly signal: HarnessSignal;
}

/**
 * Tags whose closing form must balance their opening form. Imbalanced opens
 * yield {@link SignalParseDiagnostic} `unclosed-tag` entries — the parser's
 * silent drop is observable without changing the signal vocabulary.
 *
 * `evaluation-passed` and `task-complete` are intentionally absent — they are
 * marker tags with no closing form by design.
 */
const CLOSED_TAGS: readonly string[] = [
  'progress',
  'evaluation-failed',
  'task-verified',
  'task-blocked',
  'note',
  'check-script',
  'agents-md',
  'setup-script',
  'verify-script',
  'skill-suggestions',
];

const SAMPLE_MAX = 80;

function clipSample(raw: string, index: number): string {
  const slice = raw.slice(index, index + SAMPLE_MAX);
  return slice.replace(/\s+/g, ' ').trim();
}

/**
 * Detect every opening tag in {@link CLOSED_TAGS} that has no matching close.
 * For each surplus open we emit one diagnostic anchored at the unmatched
 * opening tag's source index.
 */
function collectUnclosedTagDiagnostics(raw: string): SignalParseDiagnostic[] {
  const diagnostics: SignalParseDiagnostic[] = [];
  for (const tag of CLOSED_TAGS) {
    const openRe = new RegExp(`<${tag}>`, 'g');
    const closeRe = new RegExp(`</${tag}>`, 'g');
    const opens: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(raw)) !== null) opens.push(m.index);
    let closeCount = 0;
    while (closeRe.exec(raw) !== null) closeCount += 1;
    const surplus = opens.length - closeCount;
    if (surplus <= 0) continue;
    // Take the LAST `surplus` opens — earlier opens are the ones that
    // matched their closers; the trailing ones are the dangling spans.
    const unmatched = opens.slice(opens.length - surplus);
    for (const index of unmatched) {
      diagnostics.push({
        kind: 'unclosed-tag',
        tag,
        sample: clipSample(raw, index),
        index,
      });
    }
  }
  return diagnostics;
}

/**
 * Detect lines that *look like* attempted dimension declarations but don't
 * match the strict score-annotated regex. Surfaces evaluator prompt drift —
 * `**Correctness**: PASS — finding` (old PASS/FAIL format) and similar
 * variants no longer parse, but they used to, and a silent drop is exactly
 * how regression looks from the outside.
 */
function collectMalformedDimensionDiagnostics(raw: string, strictDimensionRe: RegExp): SignalParseDiagnostic[] {
  // Match anything starting with `**…**` at line start (allowing leading
  // whitespace). We then re-test the FULL strict regex against the same
  // line — if it doesn't match, we have drift.
  const looksLikeDimensionRe = /^[ \t]*\*\*[^*\n]+\*\*[^\n]*/gm;
  const diagnostics: SignalParseDiagnostic[] = [];
  let m: RegExpExecArray | null;
  while ((m = looksLikeDimensionRe.exec(raw)) !== null) {
    const line = m[0];
    // Build a fresh strict regex per line — sharing `lastIndex` across
    // RE_strict.test() calls would skip alternate lines.
    const strict = new RegExp(strictDimensionRe.source, strictDimensionRe.flags.replace('g', ''));
    if (strict.test(line)) continue;
    diagnostics.push({
      kind: 'malformed-dimension',
      sample: clipSample(raw, m.index),
      index: m.index,
    });
  }
  return diagnostics;
}

export class SignalParser implements SignalParserPort {
  parse(rawOutput: string, opts?: { readonly now: IsoTimestamp }): readonly HarnessSignal[] {
    return this.parseWithDiagnostics(rawOutput, opts).signals;
  }

  parseWithDiagnostics(rawOutput: string, opts?: { readonly now: IsoTimestamp }): ParseWithDiagnosticsResult {
    if (rawOutput.length === 0) return { signals: [], diagnostics: [] };

    const timestamp = opts?.now ?? IsoTimestamp.now();
    const patterns = buildPatterns();
    const collected: IndexedSignal[] = [];

    // Progress — multi-match.
    let m: RegExpExecArray | null;
    while ((m = patterns.progress.exec(rawOutput)) !== null) {
      const inner = m[1]?.trim() ?? '';
      if (inner.length === 0) continue;
      const sig: ProgressSignal = { type: 'progress', summary: inner, timestamp };
      collected.push({ index: m.index, signal: sig });
    }

    // Evaluation — `<evaluation-passed>` wins over `<evaluation-failed>` when
    // both appear (mirrors legacy precedence). Dimensions parsed once and
    // attached to whichever variant emits.
    const dimensions = parseDimensionScores(rawOutput, patterns.dimension);
    const overallScore = computeOverallScore(dimensions);
    const passedMatch = patterns.evaluationPassed.exec(rawOutput);
    if (passedMatch !== null) {
      const sig: EvaluationSignal = {
        type: 'evaluation',
        status: 'passed',
        dimensions,
        ...(overallScore !== undefined ? { overallScore } : {}),
        timestamp,
      };
      collected.push({ index: passedMatch.index, signal: sig });
    } else {
      const failedMatch = patterns.evaluationFailed.exec(rawOutput);
      if (failedMatch?.[1] !== undefined) {
        const critique = failedMatch[1].trim();
        const status = dimensions.length > 0 ? 'failed' : 'malformed';
        const sig: EvaluationSignal =
          status === 'failed'
            ? {
                type: 'evaluation',
                status,
                dimensions,
                ...(overallScore !== undefined ? { overallScore } : {}),
                critique,
                timestamp,
              }
            : { type: 'evaluation', status, dimensions, timestamp };
        collected.push({ index: failedMatch.index, signal: sig });
      } else if (dimensions.length > 0) {
        // Dimensions present without a closing tag → still treat as failed.
        // Anchor the index at the first dimension match for source-order
        // stability.
        patterns.dimension.lastIndex = 0;
        const firstDim = patterns.dimension.exec(rawOutput);
        const idx = firstDim?.index ?? 0;
        const sig: EvaluationSignal = {
          type: 'evaluation',
          status: 'failed',
          dimensions,
          ...(overallScore !== undefined ? { overallScore } : {}),
          timestamp,
        };
        collected.push({ index: idx, signal: sig });
      }
    }

    // Task lifecycle — verified, complete, blocked.
    const verifiedMatch = patterns.taskVerified.exec(rawOutput);
    if (verifiedMatch?.[1] !== undefined) {
      const sig: TaskVerifiedSignal = {
        type: 'task-verified',
        output: verifiedMatch[1].trim(),
        timestamp,
      };
      collected.push({ index: verifiedMatch.index, signal: sig });
    }

    const completeMatch = patterns.taskComplete.exec(rawOutput);
    if (completeMatch !== null) {
      const sig: TaskCompleteSignal = { type: 'task-complete', timestamp };
      collected.push({ index: completeMatch.index, signal: sig });
    }

    const blockedMatch = patterns.taskBlocked.exec(rawOutput);
    if (blockedMatch?.[1] !== undefined) {
      const sig: TaskBlockedSignal = {
        type: 'task-blocked',
        reason: blockedMatch[1].trim(),
        timestamp,
      };
      collected.push({ index: blockedMatch.index, signal: sig });
    }

    // Notes — multi-match.
    while ((m = patterns.note.exec(rawOutput)) !== null) {
      const inner = m[1]?.trim() ?? '';
      if (inner.length === 0) continue;
      const sig: NoteSignal = { type: 'note', text: inner, timestamp };
      collected.push({ index: m.index, signal: sig });
    }

    // Setup-time signals — first match only, drop unsafe shapes silently.
    const checkMatch = patterns.checkScript.exec(rawOutput);
    if (checkMatch?.[1] !== undefined) {
      const command = checkMatch[1].trim();
      if (command.length > 0 && !isDangerousCommand(command)) {
        const sig: CheckScriptDiscoverySignal = {
          type: 'check-script-discovery',
          command,
          timestamp,
        };
        collected.push({ index: checkMatch.index, signal: sig });
      }
    }

    const agentsMatch = patterns.agentsMd.exec(rawOutput);
    if (agentsMatch?.[1] !== undefined) {
      const content = agentsMatch[1].trim();
      if (content.length > 0) {
        const sig: AgentsMdProposalSignal = {
          type: 'agents-md-proposal',
          content,
          timestamp,
        };
        collected.push({ index: agentsMatch.index, signal: sig });
      }
    }

    // Onboarding-time setup / verify scripts share the check-script
    // denylist so an LLM can't seed an exec-able pipe-to-shell payload.
    const setupMatch = patterns.setupScript.exec(rawOutput);
    if (setupMatch?.[1] !== undefined) {
      const command = setupMatch[1].trim();
      if (command.length > 0 && !isDangerousCommand(command)) {
        const sig: SetupScriptSignal = {
          type: 'setup-script',
          command,
          timestamp,
        };
        collected.push({ index: setupMatch.index, signal: sig });
      }
    }

    const verifyMatch = patterns.verifyScript.exec(rawOutput);
    if (verifyMatch?.[1] !== undefined) {
      const command = verifyMatch[1].trim();
      if (command.length > 0 && !isDangerousCommand(command)) {
        const sig: VerifyScriptSignal = {
          type: 'verify-script',
          command,
          timestamp,
        };
        collected.push({ index: verifyMatch.index, signal: sig });
      }
    }

    const skillsMatch = patterns.skillSuggestions.exec(rawOutput);
    if (skillsMatch?.[1] !== undefined) {
      const names = parseSkillBullets(skillsMatch[1]);
      // Emit the signal even when names is empty — onboarding's review
      // step distinguishes "AI declined" (no tag) from "AI considered and
      // suggested nothing" (tag present, list empty).
      const sig: SkillSuggestionsSignal = {
        type: 'skill-suggestions',
        names,
        timestamp,
      };
      collected.push({ index: skillsMatch.index, signal: sig });
    }

    // Stable sort by source index so the dashboard sees the timeline as it
    // actually appeared in the AI output.
    collected.sort((a, b) => a.index - b.index);

    // Diagnostics — observation only, never enforcement. The strict-regex
    // dimension parser above is unchanged; this pass independently scans for
    // the two highest-leverage drift signatures so silently-dropped output
    // becomes visible in logs and on the dashboard.
    const diagnostics: SignalParseDiagnostic[] = [
      ...collectUnclosedTagDiagnostics(rawOutput),
      ...collectMalformedDimensionDiagnostics(rawOutput, patterns.dimension),
    ];
    diagnostics.sort((a, b) => a.index - b.index);

    return {
      signals: collected.map((c) => c.signal),
      diagnostics,
    };
  }
}

/**
 * Parse a `<skill-suggestions>` body into a deduped, trimmed list of
 * skill names. Accepts a markdown bullet list — `- name` per line — and
 * silently drops blank lines, non-bullets, and duplicates.
 */
function parseSkillBullets(body: string): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (!line.startsWith('-')) continue;
    const name = line.slice(1).trim();
    if (name.length === 0) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
