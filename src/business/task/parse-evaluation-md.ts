/**
 * Parse `evaluation.md` — the operator-readable verdict the evaluator leaf's contract renders per
 * round — back into a structured model the TUI overlay and the CLI can present. Pure: takes a
 * string, returns a value. The inverse of `renderEvaluationMarkdown`
 * (`integration/ai/contract/_engine/render-evaluation-markdown.ts`), which is the layout contract:
 *
 *     # Evaluation — <passed | failed | malformed>
 *
 *     _<iso-timestamp>_
 *
 *     ## Critique
 *     <critique prose>
 *
 *     ## Dimensions
 *
 *     ### <dimension name> — <passed | failed | n/a>
 *     <finding>
 *
 *     ```
 *     <execution evidence — when present>
 *     ```
 *
 * The round-trip is deliberately LOSSY in two known places, pinned by
 * `tests/integration/ai/contract/evaluation-markdown-roundtrip.test.ts`: per-criterion verdicts
 * (`EvaluationSignal.criteria[]`) are never rendered, and `applicable: false` collapses onto the
 * literal word `n/a`.
 *
 * No `Result` envelope: parsing a file the harness wrote days ago has no failure mode, only
 * degraded fidelity. A garbled heading yields `status: 'unknown'` and a heading with no verdict
 * yields `verdict: 'unknown'` — the parser never fabricates a pass or a fail, because a fabricated
 * verdict displayed next to a real one is worse than no verdict at all.
 *
 * Tolerances (all pinned by `tests/unit/business/task/parse-evaluation-md.test.ts`): unknown `##`
 * sections are ignored; a missing `# Evaluation` heading still yields whatever dimensions parse; an
 * unterminated fence runs to the end of its section; `##` / `###` lines inside a fenced evidence
 * block split neither a section nor a dimension; CRLF line endings parse identically to LF (the
 * harness always writes LF, but a Windows editor round-trip is exactly the "hand-edited file" case
 * this parser exists for — and every heading regex is `$`-anchored, which a trailing `\r` would
 * otherwise defeat wholesale). An UNFENCED `## ` line inside a critique body DOES end the critique
 * — the section grammar is flat by design, and the evaluator prompt never emits one.
 */

/** Verdict word for one dimension row. `unknown` = the heading carried no parseable verdict. */
export type ParsedDimensionVerdict = 'passed' | 'failed' | 'n/a' | 'unknown';

export interface ParsedEvaluationDimension {
  readonly dimension: string;
  readonly verdict: ParsedDimensionVerdict;
  /** Finding prose under the heading, fenced evidence removed. Empty string when absent. */
  readonly finding: string;
  /** Fenced execution-evidence block with the fences stripped. Absent when the dimension has none. */
  readonly evidence?: string;
}

export interface ParsedEvaluation {
  /** `unknown` when the `# Evaluation — <status>` heading is absent or carries a garbled word. */
  readonly status: 'passed' | 'failed' | 'malformed' | 'unknown';
  /**
   * The raw `_<timestamp>_` line verbatim — deliberately NOT a branded `IsoTimestamp`. The file
   * may be arbitrarily old or hand-edited; a brand parse would have to fail somewhere, and there
   * is nothing useful to do with that failure.
   */
  readonly timestamp?: string;
  readonly critique?: string;
  readonly dimensions: readonly ParsedEvaluationDimension[];
}

/** Em dash (the renderer's separator) or a plain hyphen, so a hand-edited file still parses. */
const TITLE_RE = /^#\s+Evaluation\s*[—-]\s*(.*)$/;
const TIMESTAMP_RE = /^_(.+)_$/;
const SECTION_RE = /^##\s+(.+)$/;
const DIMENSION_RE = /^###\s+(.+)$/;
const FENCE_RE = /^\s*```/;
const VERDICT_SPLIT_RE = /\s+[—-]\s+/;

const STATUSES = new Set(['passed', 'failed', 'malformed']);
const DIMENSION_VERDICTS = new Set<ParsedDimensionVerdict>(['passed', 'failed', 'n/a']);

interface Section {
  readonly title: string;
  readonly body: readonly string[];
}

/**
 * Split the document into `## `-delimited sections plus the preamble (everything before the first
 * one), which is where the title + timestamp live. Fence-aware for the same reason
 * `splitDimensionBlocks` is: a dimension's execution evidence can legitimately contain a `## `
 * line (a diff hunk header, a nested markdown snippet), and treating it as a section boundary
 * would end `## Dimensions` mid-block and silently drop every dimension after it.
 */
const splitSections = (
  lines: readonly string[]
): { readonly preamble: readonly string[]; readonly sections: readonly Section[] } => {
  const preamble: string[] = [];
  const sections: Array<{ title: string; body: string[] }> = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const match = inFence ? null : SECTION_RE.exec(line);
    if (match !== null) {
      sections.push({ title: match[1]?.trim().toLowerCase() ?? '', body: [] });
      continue;
    }
    const current = sections[sections.length - 1];
    if (current === undefined) preamble.push(line);
    else current.body.push(line);
  }
  return { preamble, sections };
};

/**
 * Split a `## Dimensions` body into `### `-delimited blocks. Fence-aware: a ```` ``` ```` block
 * inside a dimension can legitimately contain a line starting with `###` (a shell comment, a diff
 * hunk, a nested markdown snippet), and splitting on it would tear one dimension into two.
 */
const splitDimensionBlocks = (
  body: readonly string[]
): ReadonlyArray<{ readonly heading: string; readonly body: readonly string[] }> => {
  const blocks: Array<{ heading: string; body: string[] }> = [];
  let inFence = false;
  for (const line of body) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const match = inFence ? null : DIMENSION_RE.exec(line);
    if (match !== null) {
      blocks.push({ heading: match[1]?.trim() ?? '', body: [] });
      continue;
    }
    blocks[blocks.length - 1]?.body.push(line);
  }
  return blocks;
};

/** `<name> — <verdict>` → the pair, with an unparseable verdict degrading to `unknown`. */
const parseDimensionHeading = (
  heading: string
): { readonly dimension: string; readonly verdict: ParsedDimensionVerdict } => {
  const parts = heading.split(VERDICT_SPLIT_RE);
  const tail = parts.length > 1 ? parts[parts.length - 1]?.trim().toLowerCase() : undefined;
  if (tail !== undefined && DIMENSION_VERDICTS.has(tail as ParsedDimensionVerdict)) {
    return { dimension: parts.slice(0, -1).join(' — ').trim(), verdict: tail as ParsedDimensionVerdict };
  }
  return { dimension: heading, verdict: 'unknown' };
};

/**
 * Peel the fenced evidence block out of a dimension body, returning the remaining prose as the
 * finding. An unterminated fence swallows the rest of the block — the alternative (dropping it)
 * would hide the very command output the operator opened the file to read.
 */
const splitFindingAndEvidence = (body: readonly string[]): { readonly finding: string; readonly evidence?: string } => {
  const prose: string[] = [];
  const evidence: string[] = [];
  let inFence = false;
  for (const line of body) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) evidence.push(line);
    else prose.push(line);
  }
  const evidenceText = evidence.join('\n').trim();
  return {
    finding: prose.join('\n').trim(),
    ...(evidenceText.length > 0 ? { evidence: evidenceText } : {}),
  };
};

const parseDimensions = (body: readonly string[]): readonly ParsedEvaluationDimension[] =>
  splitDimensionBlocks(body).map((block) => {
    const { dimension, verdict } = parseDimensionHeading(block.heading);
    return { dimension, verdict, ...splitFindingAndEvidence(block.body) };
  });

export const parseEvaluationMarkdown = (text: string): ParsedEvaluation => {
  // Strip the CR of a CRLF pair before anything else: `.` never matches `\r`, so a single
  // trailing carriage return makes every `$`-anchored heading regex below miss and collapses an
  // otherwise-perfect document to `status: 'unknown'` with no sections at all.
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const { preamble, sections } = splitSections(lines);

  const titleLine = preamble.map((l) => TITLE_RE.exec(l)).find((m) => m !== null);
  const statusWord = titleLine?.[1]?.trim().toLowerCase() ?? '';
  const status = STATUSES.has(statusWord) ? (statusWord as 'passed' | 'failed' | 'malformed') : 'unknown';

  const timestampLine = preamble.map((l) => TIMESTAMP_RE.exec(l.trim())).find((m) => m !== null);
  const timestamp = timestampLine?.[1]?.trim();

  const critique = sections
    .find((s) => s.title === 'critique')
    ?.body.join('\n')
    .trim();
  const dimensionsBody = sections.find((s) => s.title === 'dimensions')?.body ?? [];

  return {
    status,
    ...(timestamp !== undefined && timestamp.length > 0 ? { timestamp } : {}),
    ...(critique !== undefined && critique.length > 0 ? { critique } : {}),
    dimensions: parseDimensions(dimensionsBody),
  };
};
