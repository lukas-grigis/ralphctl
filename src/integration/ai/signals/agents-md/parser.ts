import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AgentsMdProposalSignal } from '@src/domain/signal.ts';
import type { SignalMatch, SignalParser } from '@src/integration/ai/signals/_engine/parser-types.ts';

/**
 * Context-file proposal from `project readiness`. The AI emits one of three tool-specific
 * wire tags depending on which assistant the prompt was built for:
 *
 *  - `<claude-md>...</claude-md>`            → CLAUDE.md
 *  - `<copilot-instructions>...`             → .github/copilot-instructions.md
 *  - `<agents-md>...</agents-md>`            → AGENTS.md
 *
 * All three map to the same {@link AgentsMdProposalSignal}; the `tag` field on the signal
 * tells the readiness leaf which tag the AI actually used (so it can validate the AI emitted
 * the right one for the tool the prompt targeted).
 *
 * Matching is case-insensitive — Codex's exec mode occasionally uppercases or title-cases
 * XML-ish tags when echoing template-driven output. Matching loosely costs nothing and avoids
 * a re-prompt loop over trivial casing drift. Body is multi-paragraph markdown — surrounding
 * whitespace trimmed, internal whitespace preserved. Whitespace-only body → no match.
 */
const TAGS: ReadonlyArray<AgentsMdProposalSignal['tag']> = ['claude-md', 'copilot-instructions', 'agents-md'];

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const matches: SignalMatch[] = [];
  for (const tag of TAGS) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const body = m[1] ?? '';
      const content = body.trim();
      if (content.length === 0) continue;
      matches.push({
        index: m.index,
        length: m[0].length,
        signal: { type: 'agents-md-proposal', tag, content, timestamp },
      });
    }
  }
  return matches;
};

export const agentsMdParser: SignalParser = { tag: 'agents-md', parse };
