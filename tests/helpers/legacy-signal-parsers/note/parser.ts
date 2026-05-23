import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@tests/helpers/legacy-signal-parsers/_engine/parser-types.ts';

/** `<note>text</note>` — incidental observation streamed to the UI; not persisted by default. */
const RE = /<note>([\s\S]*?)<\/note>/g;

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const matches: SignalMatch[] = [];
  const re = new RegExp(RE.source, RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1] ?? '';
    matches.push({
      index: m.index,
      length: m[0].length,
      signal: { type: 'note', text: body.trim(), timestamp },
    });
  }
  return matches;
};

export const noteParser: SignalParser = { tag: 'note', parse };
