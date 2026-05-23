import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@tests/helpers/legacy-signal-parsers/_engine/parser-types.ts';

/**
 * `<verify-skill>...</verify-skill>` — multi-paragraph markdown body proposing the project's
 * verification convention. Same shape as `<setup-skill>`: prose body, surrounding whitespace
 * trimmed, internal whitespace preserved.
 */
const RE = /<verify-skill>([\s\S]*?)<\/verify-skill>/g;

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const matches: SignalMatch[] = [];
  const re = new RegExp(RE.source, RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1] ?? '';
    const content = body.trim();
    if (content.length === 0) continue;
    matches.push({
      index: m.index,
      length: m[0].length,
      signal: { type: 'verify-skill-proposal', content, timestamp },
    });
  }
  return matches;
};

export const verifySkillParser: SignalParser = { tag: 'verify-skill', parse };
