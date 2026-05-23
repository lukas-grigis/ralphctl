import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@tests/helpers/legacy-signal-parsers/_engine/parser-types.ts';

/**
 * `<decision>text</decision>` — architectural / design choice with rationale. Higher
 * signal than `<learning>`: an intentional choice, not a passive observation. Emitted
 * onto the harness signal stream; rendering is up to the registered sink.
 */
const RE = /<decision>([\s\S]*?)<\/decision>/g;

/**
 * Maximum body length tolerated for a single `<decision>` match. Anything past this is
 * treated as a runaway open tag — the regex is lazy but if the AI emits an unmatched
 * `<decision>` open inside e.g. a `<thinking>` block, the next stray `</decision>`
 * downstream (commonly from quoted prompt examples) closes the match and swallows
 * an arbitrary slab of prose. Capping the body length is the first line of defence.
 *
 * 500 chars is generous for a one-sentence rationale (the prompt asks for one sentence)
 * but small enough that a runaway match is unambiguously detectable.
 */
export const MAX_DECISION_BODY_CHARS = 500;

/**
 * Section-header marker. A legitimate decision body never embeds a markdown `## ` header
 * mid-sentence — its presence indicates the regex swallowed prompt structure.
 */
const SECTION_HEADER_MARKER = '\n## ';

/**
 * A triple backtick opens or closes a fenced code block. Three blocks means six fences.
 * A real decision rationale never embeds three code blocks; this many fences means the
 * match swallowed a prompt's example section.
 */
const TRIPLE_BACKTICK = '```';
const MAX_TRIPLE_BACKTICK_OCCURRENCES = 5;

const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + needle.length;
  }
};

const isRunawayMatch = (body: string): boolean => {
  if (body.length > MAX_DECISION_BODY_CHARS) return true;
  if (body.includes(SECTION_HEADER_MARKER)) return true;
  if (countOccurrences(body, TRIPLE_BACKTICK) > MAX_TRIPLE_BACKTICK_OCCURRENCES) return true;
  return false;
};

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const matches: SignalMatch[] = [];
  const re = new RegExp(RE.source, RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1] ?? '';
    if (body.trim().length === 0) continue;
    if (isRunawayMatch(body)) continue;
    matches.push({
      index: m.index,
      length: m[0].length,
      signal: { type: 'decision', text: body.trim(), timestamp },
    });
  }
  return matches;
};

export const decisionParser: SignalParser = { tag: 'decision', parse };
