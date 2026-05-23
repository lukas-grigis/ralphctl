import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@tests/helpers/legacy-signal-parsers/_engine/parser-types.ts';

/**
 * `<task-blocked>reason</task-blocked>` — generator can't make progress (missing dependency,
 * ambiguous step, scope mismatch). The reason is surfaced to the operator verbatim. Empty
 * reasons are accepted; the harness will fall back to a generic "task blocked" message.
 */
const RE = /<task-blocked>([\s\S]*?)<\/task-blocked>/g;

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const matches: SignalMatch[] = [];
  const re = new RegExp(RE.source, RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1] ?? '';
    matches.push({
      index: m.index,
      length: m[0].length,
      signal: { type: 'task-blocked', reason: body.trim(), timestamp },
    });
  }
  return matches;
};

export const taskBlockedParser: SignalParser = { tag: 'task-blocked', parse };
