import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@src/integration/ai/signals/_engine/parser-types.ts';

/**
 * `<task-complete>` — self-closing signal. Accepts `<task-complete>`, `<task-complete/>`,
 * `<task-complete></task-complete>`. Order semantics (must follow `<task-verified>`) is the
 * scheduler's concern, not the parser's.
 */
const RE = /<task-complete\s*\/?>|<task-complete><\/task-complete>/g;

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const matches: SignalMatch[] = [];
  const re = new RegExp(RE.source, RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({
      index: m.index,
      length: m[0].length,
      signal: { type: 'task-complete', timestamp },
    });
  }
  return matches;
};

export const taskCompleteParser: SignalParser = { tag: 'task-complete', parse };
