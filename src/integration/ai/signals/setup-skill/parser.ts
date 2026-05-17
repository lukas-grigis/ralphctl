import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@src/integration/ai/signals/_engine/parser-types.ts';

/**
 * `<setup-skill>...</setup-skill>` — multi-paragraph markdown body proposing a project setup
 * convention. Emitted by `detect-skills`. Unlike `<setup-script>` the body is prose, so
 * internal whitespace and newlines are preserved; only surrounding whitespace is trimmed.
 *
 * The AI is allowed to omit the tag; whitespace-only bodies are treated as absent (no match).
 */
const RE = /<setup-skill>([\s\S]*?)<\/setup-skill>/g;

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
      signal: { type: 'setup-skill-proposal', content, timestamp },
    });
  }
  return matches;
};

export const setupSkillParser: SignalParser = { tag: 'setup-skill', parse };
