import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@src/integration/ai/signals/_engine/parser-types.ts';

/**
 * `<task-verified>output</task-verified>` — pair tag whose body is the verbatim verification
 * output (commands run + their stdout/stderr). Body is trimmed at the boundaries; interior
 * whitespace preserved so multi-line command output stays readable in the persisted attempt.
 */
const RE = /<task-verified>([\s\S]*?)<\/task-verified>/g;

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const matches: SignalMatch[] = [];
  const re = new RegExp(RE.source, RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1] ?? '';
    matches.push({
      index: m.index,
      length: m[0].length,
      signal: { type: 'task-verified', output: body.trim(), timestamp },
    });
  }
  return matches;
};

export const taskVerifiedParser: SignalParser = { tag: 'task-verified', parse };
