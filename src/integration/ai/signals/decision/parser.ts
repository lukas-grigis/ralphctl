import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@src/integration/ai/signals/_engine/parser-types.ts';

/**
 * `<decision>text</decision>` — architectural / design choice with rationale. Higher
 * signal than `<learning>`: an intentional choice, not a passive observation. Emitted
 * onto the harness signal stream; rendering is up to the registered sink.
 */
const RE = /<decision>([\s\S]*?)<\/decision>/g;

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
      signal: { type: 'decision', text: body.trim(), timestamp },
    });
  }
  return matches;
};

export const decisionParser: SignalParser = { tag: 'decision', parse };
