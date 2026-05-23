import type { EvaluationSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@tests/helpers/legacy-signal-parsers/_engine/parser-types.ts';

/**
 * Test-only evaluator parser. Recognises the legacy `<evaluation-passed>` (self-closing) and
 * `<evaluation-failed>critique</evaluation-failed>` markers in fake-AI test fixtures and
 * synthesises a {@link EvaluationSignal} carrying the PASS / FAIL verdict.
 *
 * Production no longer parses these tags from stdout — the file-based contract pipeline owns
 * evaluation verdicts (`signals.json` + `evaluationSignalSchema`). This parser exists solely so
 * existing e2e / integration tests that bake `<evaluation-*>` strings into the fake AI
 * provider's responses keep working without each test re-authoring an explicit
 * `signals: { evaluate: [...] }` array.
 *
 * Both verdicts emit `dimensions: []` and (for the failed case) the critique body as `critique`.
 * No dimension-row parsing — the old per-dimension parser (with 1–5 numeric scoring) was
 * deleted alongside the rubric redesign.
 */
const VERDICT_PASSED_RE = /<evaluation-passed\s*\/?>|<evaluation-passed><\/evaluation-passed>/g;
const VERDICT_FAILED_RE = /<evaluation-failed>([\s\S]*?)<\/evaluation-failed>/g;

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
  const passed = findFirstPassedVerdict(text);
  const failed = findFirstFailedVerdict(text);
  if (passed === undefined && failed === undefined) return [];

  if (passed !== undefined && (failed === undefined || passed.index < failed.index)) {
    const signal: EvaluationSignal = {
      type: 'evaluation',
      status: 'passed',
      dimensions: [],
      timestamp,
    };
    return [{ index: passed.index, length: passed.length, signal }];
  }

  const failedHit = failed as { index: number; length: number; critique: string };
  // The status-vs-dimensions refinement on `evaluationSignalSchema` requires `status: 'failed'`
  // to carry at least one failing dimension — synthesise a single placeholder so the fake's
  // verdict survives the contract validator without forcing every test to author dimensions.
  const signal: EvaluationSignal = {
    type: 'evaluation',
    status: 'failed',
    dimensions: [
      { dimension: 'overall', passed: false, finding: failedHit.critique.length > 0 ? failedHit.critique : 'failed' },
    ],
    critique: failedHit.critique,
    timestamp,
  };
  return [{ index: failedHit.index, length: failedHit.length, signal }];
};

export const evaluationParser: SignalParser = { tag: 'evaluation', parse };
