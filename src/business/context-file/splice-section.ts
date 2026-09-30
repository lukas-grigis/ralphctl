import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Pure splice helpers for the two flows that edit a provider-native context file (CLAUDE.md /
 * AGENTS.md / copilot-instructions.md). The model emits only its DELTA — the owned section body
 * (distill) or the appended H2 sections (readiness) — and these helpers merge it into the existing
 * file, so every byte outside the edited region is preserved by construction rather than by asking
 * the model to retype it.
 *
 * Line endings: the existing file's convention wins (CRLF when it contains any `\r\n`, else LF);
 * the model's delta is normalised to it. Headings inside fenced code blocks are ignored.
 */

interface Line {
  readonly start: number;
  /** Offset just past the line terminator (or the text length for a final unterminated line). */
  readonly end: number;
  /** Line content without its terminator. */
  readonly text: string;
}

const splitLines = (text: string): readonly Line[] => {
  const lines: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl + 1;
    const raw = text.slice(start, nl === -1 ? text.length : nl);
    lines.push({ start, end, text: raw.endsWith('\r') ? raw.slice(0, -1) : raw });
    start = end;
  }
  return lines;
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// ATX heading: 0-3 spaces, 1-6 hashes, then whitespace or end of line.
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

interface Heading {
  readonly lineIndex: number;
  readonly level: number;
  /** Heading text with the optional closing `#` run and surrounding whitespace removed. */
  readonly title: string;
}

/** ATX headings outside fenced code blocks. */
const headingsOf = (lines: readonly Line[]): readonly Heading[] => {
  const out: Heading[] = [];
  let fence: string | undefined;
  lines.forEach((line, lineIndex) => {
    const f = FENCE.exec(line.text);
    if (f?.[1] !== undefined) {
      const marker = f[1];
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.text.trim() === marker)
        fence = undefined;
      return;
    }
    if (fence !== undefined) return;
    const m = ATX.exec(line.text);
    if (m?.[1] === undefined) return;
    const title = (m[2] ?? '')
      .replace(/[ \t]+#+$/, '')
      .replace(/^#+$/, '')
      .trim();
    out.push({ lineIndex, level: m[1].length, title });
  });
  return out;
};

const normTitle = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

const eolOf = (text: string): '\r\n' | '\n' => (text.includes('\r\n') ? '\r\n' : '\n');

const toEol = (text: string, eol: string): string => text.replace(/\r\n|\r|\n/g, eol);

const err = (field: string, value: unknown, message: string): Result<never, ValidationError> =>
  Result.error(new ValidationError({ field, value, message }));

/**
 * Trim the model's section body, dropping a leading echo of the owned heading. Rejects an empty
 * body or one carrying its own H1/H2 heading (outside fenced code).
 */
const normaliseBody = (sectionBody: string, wantedTitle: string): Result<string, ValidationError> => {
  const bodyLines = splitLines(toEol(sectionBody, '\n')).map((l) => l.text);
  while (bodyLines.length > 0 && (bodyLines[0] ?? '').trim() === '') bodyLines.shift();
  const first = bodyLines[0];
  if (first !== undefined) {
    const m = ATX.exec(first);
    if (m?.[1] === '##' && normTitle((m[2] ?? '').replace(/[ \t]+#+$/, '')) === wantedTitle) bodyLines.shift();
  }
  const cleaned = bodyLines.join('\n').trim();
  if (cleaned === '') return err('sectionBody', sectionBody, 'owned section body is empty; refusing to write');
  if (headingsOf(splitLines(cleaned)).some((h) => h.level <= 2)) {
    return err(
      'sectionBody',
      sectionBody,
      'owned section body contains its own H1/H2 heading; expected only the body of the owned section'
    );
  }
  return Result.ok(cleaned);
};

/**
 * Replace the `## <heading>` section of `existing` with `sectionBody`, or append the section at the
 * end when absent. Everything else is preserved byte-for-byte.
 *
 * Fails safe (returns an error, nothing to write) when:
 *  - the file contains more than one `## <heading>` section (ambiguous which to replace);
 *  - `sectionBody` is empty (would wipe the section);
 *  - `sectionBody` contains an H1/H2 heading of its own (it would corrupt the surrounding structure).
 *
 * A leading `## <heading>` line in `sectionBody` is tolerated and dropped — models often echo it.
 * Idempotent: splicing the same body twice yields the same file.
 */
export const spliceOwnedSection = (
  existing: string,
  heading: string,
  sectionBody: string
): Result<string, ValidationError> => {
  const wanted = normTitle(heading);
  if (wanted === '') return err('heading', heading, 'owned section heading must not be empty');

  const eol = eolOf(existing);
  const body = normaliseBody(sectionBody, wanted);
  if (!body.ok) return Result.error(body.error);
  const cleaned = body.value;

  const section = `## ${heading.trim()}${eol}${eol}${toEol(cleaned, eol)}`;

  const lines = splitLines(existing);
  const headings = headingsOf(lines);
  const owned = headings.filter((h) => h.level === 2 && normTitle(h.title) === wanted);
  if (owned.length > 1) {
    return err(
      'existing',
      heading,
      `context file has ${String(owned.length)} "## ${heading.trim()}" sections; refusing to guess which to replace`
    );
  }

  const target = owned[0];
  if (target === undefined) return Result.ok(appendBlock(existing, section, eol));

  const startLine = lines[target.lineIndex];
  if (startLine === undefined) return err('existing', heading, 'internal: heading line out of range');
  const next = headings.find((h) => h.lineIndex > target.lineIndex && h.level <= 2);
  const endOffset = next === undefined ? existing.length : (lines[next.lineIndex]?.start ?? existing.length);
  const oldSection = existing.slice(startLine.start, endOffset);
  // Keep the old section's trailing whitespace (blank lines / final newline) so the spacing around
  // it — and the presence or absence of a final newline at EOF — is unchanged.
  const trailing = oldSection.slice(oldSection.replace(/\s+$/, '').length);
  return Result.ok(existing.slice(0, startLine.start) + section + trailing + existing.slice(endOffset));
};

/** Append `block` after `existing`, separated by one blank line, ending with a newline. */
const appendBlock = (existing: string, block: string, eol: string): string => {
  if (existing.trim() === '') return `${block}${eol}`;
  let head = existing;
  if (!head.endsWith('\n')) head += eol;
  if (!/(?:\r?\n){2}$/.test(head)) head += eol;
  return `${head}${block}${eol}`;
};

/**
 * `additions` is the existing body plus more — it equals `body`, or `body` is followed by a line
 * break. A bare `startsWith` would read `# Foo bar` as the full file of `# Foo` and drop the original.
 * Both arguments are LF-normalized.
 */
const isFullFile = (additions: string, body: string): boolean =>
  additions === body || (additions.startsWith(body) && additions[body.length] === '\n');

/**
 * Append the model's new H2 section(s) to `existing`, preserving `existing` byte-for-byte as a
 * prefix. Empty `additions` leaves a non-empty `existing` unchanged (the model had nothing to add) and
 * fails for an empty `existing` (nothing to propose at all).
 *
 * Tolerance for a model that ignored the delta contract: when `additions` already starts with the
 * whole existing body (trimmed) followed by a line break, it is treated as the full file and returned
 * as-is, so the body is never duplicated.
 */
export const appendSections = (existing: string, additions: string): Result<string, ValidationError> => {
  const cleaned = additions.trim();
  if (cleaned === '') {
    return existing.trim() === ''
      ? err('additions', additions, 'proposed context file is empty; refusing to write')
      : Result.ok(existing);
  }
  const eol = eolOf(existing);
  const existingTrimmed = existing.trim();
  if (existingTrimmed !== '' && isFullFile(toEol(cleaned, '\n'), toEol(existingTrimmed, '\n'))) {
    return Result.ok(additions);
  }
  return Result.ok(appendBlock(existing, toEol(cleaned, eol), eol));
};
