import type { DimensionScore, DimensionScoreValue, EvaluationSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@tests/helpers/legacy-signal-parsers/_engine/parser-types.ts';

/**
 * Evaluation parser. Extracts:
 *   1. Per-dimension scoring lines from the markdown body.
 *   2. The terminal verdict signal: `<evaluation-passed>` or `<evaluation-failed>critique</...>`.
 *
 * Locked dimension format (matches `templates/evaluate.md`):
 *
 *     ### <Name> — <passed|failed> (<score>)
 *
 *     {free-form findings}
 *
 * Where `<Name>` is alphanumeric + spaces (e.g. `Correctness`, `Performance`, `Migration Safety`),
 * `<passed|failed>` is the status literal, and `<score>` is a digit 1–5. The optional finding
 * is the first non-empty paragraph after the heading (limited to 1 line for tight rendering).
 *
 * Verdict semantics:
 *   - One `<evaluation-passed>` (self-closing) emits `status: 'passed'`.
 *   - One `<evaluation-failed>...</evaluation-failed>` emits `status: 'failed'`, body as critique.
 *   - No verdict but dimensions present → `status: 'malformed'` (AI scored but didn't summarise).
 *   - No verdict and no dimensions → no signal (AI didn't attempt an evaluation).
 *
 * `overallScore` is the mean of dimension scores, rounded to one decimal. Undefined when
 * `dimensions` is empty.
 *
 * Index reported for the merged stream is the position of the verdict signal (or the first
 * dimension heading when there is no verdict). Position determines order relative to other
 * signals in the same AI turn.
 */

const VERDICT_PASSED_RE = /<evaluation-passed\s*\/?>|<evaluation-passed><\/evaluation-passed>/g;
const VERDICT_FAILED_RE = /<evaluation-failed>([\s\S]*?)<\/evaluation-failed>/g;
const DIMENSION_HEADING_RE = /^###\s+(\S[^—\n]*?)\s+—\s+(passed|failed)\s+\((\d)\)\s*$/gm;

interface DimensionHit {
  readonly index: number;
  readonly score: DimensionScore;
}

const parseDimensions = (text: string): readonly DimensionHit[] => {
  const re = new RegExp(DIMENSION_HEADING_RE.source, DIMENSION_HEADING_RE.flags);
  const seen = new Set<string>();
  const hits: DimensionHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const rawName = m[1];
    const status = m[2];
    const rawScore = m[3];
    if (rawName === undefined || status === undefined || rawScore === undefined) continue;
    const name = rawName.trim();
    const lower = name.toLowerCase();
    if (lower.length === 0) continue;
    if (seen.has(lower)) continue;
    const scoreNum = Number(rawScore);
    if (!isValidScore(scoreNum)) continue;
    const headingEnd = m.index + m[0].length;
    const finding = extractFinding(text, headingEnd);
    seen.add(lower);
    hits.push({
      index: m.index,
      score: {
        dimension: lower,
        score: scoreNum,
        passed: status === 'passed',
        finding,
      },
    });
  }
  return hits;
};

/**
 * First non-blank paragraph after the heading. Capped at 240 chars so a verbose finding
 * doesn't blow up the persisted attempt; the full markdown is still available in the raw AI
 * output if anyone needs it.
 */
const extractFinding = (text: string, from: number): string => {
  const tail = text.slice(from);
  const lines = tail.split('\n');
  let started = false;
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      if (trimmed.length === 0) continue;
      started = true;
    }
    if (trimmed.length === 0) break;
    if (trimmed.startsWith('### ') || trimmed.startsWith('## ')) break;
    collected.push(trimmed);
    if (collected.length >= 3) break;
  }
  const joined = collected.join(' ').trim();
  return joined.length > 240 ? `${joined.slice(0, 237)}...` : joined;
};

const isValidScore = (n: number): n is DimensionScoreValue => Number.isInteger(n) && n >= 1 && n <= 5;

const meanScore = (dimensions: readonly DimensionScore[]): number | undefined => {
  if (dimensions.length === 0) return undefined;
  const total = dimensions.reduce((acc, d) => acc + d.score, 0);
  return Math.round((total / dimensions.length) * 10) / 10;
};

const findFirstPassedVerdict = (text: string): { index: number; length: number } | undefined => {
  const re = new RegExp(VERDICT_PASSED_RE.source, VERDICT_PASSED_RE.flags);
  const m = re.exec(text);
  return m === null ? undefined : { index: m.index, length: m[0].length };
};

const findFirstFailedVerdict = (text: string): { index: number; length: number; critique: string } | undefined => {
  const re = new RegExp(VERDICT_FAILED_RE.source, VERDICT_FAILED_RE.flags);
  const m = re.exec(text);
  if (m === null) return undefined;
  return { index: m.index, length: m[0].length, critique: (m[1] ?? '').trim() };
};

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const dimensions = parseDimensions(text).map((h) => h.score);
  const passed = findFirstPassedVerdict(text);
  const failed = findFirstFailedVerdict(text);

  // Pick whichever verdict appears first in the document (defensive — only one expected).
  const verdict =
    passed === undefined && failed === undefined
      ? undefined
      : passed === undefined
        ? failed
        : failed === undefined
          ? passed
          : passed.index < failed.index
            ? passed
            : failed;

  if (verdict === undefined) {
    if (dimensions.length === 0) return [];
    // Dimensions present but no terminal verdict — malformed.
    const firstDim = parseDimensions(text)[0]?.index ?? 0;
    const signal: EvaluationSignal = {
      type: 'evaluation',
      status: 'malformed',
      dimensions,
      ...(meanScore(dimensions) !== undefined ? { overallScore: meanScore(dimensions)! } : {}),
      timestamp,
    };
    return [{ index: firstDim, length: 0, signal }];
  }

  const isPassed = passed !== undefined && (failed === undefined || passed.index < failed.index);
  if (isPassed) {
    const signal: EvaluationSignal = {
      type: 'evaluation',
      status: 'passed',
      dimensions,
      ...(meanScore(dimensions) !== undefined ? { overallScore: meanScore(dimensions)! } : {}),
      timestamp,
    };
    return [{ index: verdict.index, length: verdict.length, signal }];
  }

  const failedHit = failed!;
  const signal: EvaluationSignal = {
    type: 'evaluation',
    status: 'failed',
    dimensions,
    ...(meanScore(dimensions) !== undefined ? { overallScore: meanScore(dimensions)! } : {}),
    critique: failedHit.critique,
    timestamp,
  };
  return [{ index: failedHit.index, length: failedHit.length, signal }];
};

export const evaluationParser: SignalParser = { tag: 'evaluation', parse };
