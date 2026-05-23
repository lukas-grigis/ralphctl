import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@tests/helpers/legacy-signal-parsers/_engine/parser-types.ts';

/**
 * `<learning>text</learning>` — non-obvious project knowledge worth pinning across tasks.
 * Lower-stakes than `<decision>`; higher-stakes than `<note>`. Emitted onto the harness
 * signal stream; how it is rendered for the operator depends on the registered sink.
 */
const RE = /<learning>([\s\S]*?)<\/learning>/g;

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const matches: SignalMatch[] = [];
  const re = new RegExp(RE.source, RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1] ?? '';
    if (body.trim().length === 0) continue;
    matches.push({
      index: m.index,
      length: m[0].length,
      signal: { type: 'learning', text: body.trim(), timestamp },
    });
  }
  return matches;
};

export const learningParser: SignalParser = { tag: 'learning', parse };
