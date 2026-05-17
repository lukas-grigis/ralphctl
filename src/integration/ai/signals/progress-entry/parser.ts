import type { ProgressEntrySignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { extractChildTag } from '@src/integration/ai/signals/_engine/extract-child-tag.ts';
import type { SignalMatch, SignalParser } from '@src/integration/ai/signals/_engine/parser-types.ts';

/**
 * `<progress-entry>…</progress-entry>` — the v1 4-section progress block. Nested tags:
 *
 *     <progress-entry>
 *       <task>Add user-id index</task>
 *       <files-changed>
 *         - app/db.ts
 *         - migrations/0042_index.sql
 *       </files-changed>
 *       <learnings>
 *         sqlite expects explicit pragmas
 *       </learnings>
 *       <notes-for-next>
 *         still need to add the matching ORM mapping
 *       </notes-for-next>
 *     </progress-entry>
 *
 * Each child tag is independently optional and unordered. Missing children collapse to safe
 * defaults so the harness can still produce the v1 4-section block on disk:
 *  - `task`           → empty string (rendered as a generic header by the sink)
 *  - `files-changed`  → empty array
 *  - `learnings`      → empty string (sink renders `_None._`)
 *  - `notes-for-next` → empty string (sink renders `_None._`)
 *
 * `filesChanged` accepts a bulleted markdown list ("- foo" / "* foo") OR plain lines. Empty
 * lines and the leading bullet/whitespace are stripped at parse time; the domain shape sees a
 * clean string array.
 */

const ENTRY_RE = /<progress-entry>([\s\S]*?)<\/progress-entry>/g;

const parseFilesChanged = (raw: string | undefined): readonly string[] => {
  if (raw === undefined || raw.length === 0) return [];
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter((line) => line.length > 0);
};

const parse = (text: string, timestamp: IsoTimestamp): readonly SignalMatch[] => {
  const matches: SignalMatch[] = [];
  const re = new RegExp(ENTRY_RE.source, ENTRY_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1] ?? '';
    const signal: ProgressEntrySignal = {
      type: 'progress-entry',
      task: extractChildTag(body, 'task') ?? '',
      filesChanged: parseFilesChanged(extractChildTag(body, 'files-changed')),
      learnings: extractChildTag(body, 'learnings') ?? '',
      notesForNext: extractChildTag(body, 'notes-for-next') ?? '',
      timestamp,
    };
    matches.push({ index: m.index, length: m[0].length, signal });
  }
  return matches;
};

export const progressEntryParser: SignalParser = { tag: 'progress-entry', parse };
