import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SignalMatch, SignalParser } from '@src/integration/ai/signals/_engine/parser-types.ts';

/**
 * `<setup-script>command</setup-script>` — one-shot shell line the harness runs at sprint
 * start (dependency install, codegen). Emitted by `detect-scripts` and `readiness` flows.
 *
 * Whitespace is collapsed because the contract is "single shell line"; the prompt tells the
 * AI to omit the tag entirely when there's nothing to do, so a whitespace-only body is
 * treated as absent (no match). Hostile shapes (e.g. `rm -rf /`) are NOT filtered here —
 * the chain validates before execution.
 */
const RE = /<setup-script>([\s\S]*?)<\/setup-script>/gi;

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
      signal: { type: 'setup-script', command, timestamp },
    });
  }
  return matches;
};

export const setupScriptParser: SignalParser = { tag: 'setup-script', parse };
