import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { extractChildTag } from '@src/integration/ai/signals/_engine/extract-child-tag.ts';
import type { SignalMatch, SignalParser } from '@src/integration/ai/signals/_engine/parser-types.ts';

/**
 * `<commit-message><subject>…</subject><body>…</body></commit-message>` — generator-proposed
 * commit message for the harness's per-task commit. `<body>` is optional; when present its
 * text is preserved verbatim (paragraph breaks survive), otherwise the signal carries only the
 * subject and the harness writes a subject-only commit.
 *
 * Missing or empty `<subject>` drops the whole match — the harness falls back to its default
 * `task(<id>): <name>` message in that case. Whitespace around tag bodies is trimmed.
 */
const OUTER_RE = /<commit-message>([\s\S]*?)<\/commit-message>/g;

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const matches: SignalMatch[] = [];
  const re = new RegExp(OUTER_RE.source, OUTER_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1] ?? '';
    const subject = extractChildTag(inner, 'subject') ?? '';
    if (subject.length === 0) continue;
    const body = extractChildTag(inner, 'body');
    matches.push({
      index: m.index,
      length: m[0].length,
      signal: {
        type: 'commit-message',
        subject,
        ...(body !== undefined && body.length > 0 ? { body } : {}),
        timestamp,
      },
    });
  }
  return matches;
};

export const commitMessageParser: SignalParser = { tag: 'commit-message', parse };
