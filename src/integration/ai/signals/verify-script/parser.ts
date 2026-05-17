import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@src/integration/ai/signals/_engine/parser-types.ts';

/**
 * `<verify-script>command</verify-script>` — one-shot shell line the harness runs as the
 * post-task gate (typecheck / lint / test). Same shape as `<setup-script>`: single shell line,
 * whitespace collapsed, whitespace-only body treated as absent.
 */
const RE = /<verify-script>([\s\S]*?)<\/verify-script>/gi;

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const matches: SignalMatch[] = [];
  const re = new RegExp(RE.source, RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1] ?? '';
    const command = body.replace(/\s+/g, ' ').trim();
    if (command.length === 0) continue;
    matches.push({
      index: m.index,
      length: m[0].length,
      signal: { type: 'verify-script', command, timestamp },
    });
  }
  return matches;
};

export const verifyScriptParser: SignalParser = { tag: 'verify-script', parse };
