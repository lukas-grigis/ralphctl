import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@src/integration/ai/signals/_engine/parser-types.ts';

/** `<progress>summary</progress>` — one-line status update streamed to the live UI. */
const RE = /<progress>([\s\S]*?)<\/progress>/g;

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const matches: SignalMatch[] = [];
  const re = new RegExp(RE.source, RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1] ?? '';
    matches.push({
      index: m.index,
      length: m[0].length,
      signal: { type: 'progress', summary: body.trim(), timestamp },
    });
  }
  return matches;
};

export const progressParser: SignalParser = { tag: 'progress', parse };
