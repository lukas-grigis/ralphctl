import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@tests/helpers/legacy-signal-parsers/_engine/parser-types.ts';

/**
 * `<change>text</change>` — granular record of a concrete change made during a task
 * ("added X", "renamed Y to Z"). Emitted onto the harness signal stream as narrative
 * detail; how it is rendered for the operator depends on the registered sink.
 */
const RE = /<change>([\s\S]*?)<\/change>/g;

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
      signal: { type: 'change', text: body.trim(), timestamp },
    });
  }
  return matches;
};

export const changeParser: SignalParser = { tag: 'change', parse };
