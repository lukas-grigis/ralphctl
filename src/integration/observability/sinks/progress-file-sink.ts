import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { HarnessSignal, ProgressEntrySignal } from '@src/domain/signal.ts';
import type { Sink } from '@src/business/observability/sink.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { FileLocker } from '@src/integration/io/file-locker.ts';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';

/**
 * `progress.md` writer. Subscribes to the harness-signal stream and routes signals to the
 * sprint's progress file under four pinned sections:
 *
 *   # Sprint progress
 *
 *   ## Learnings        ← <learning> signals append here
 *   ## Decisions        ← <decision> signals append here
 *   ## Activity         ← <change> / <note> / <progress> / <task-blocked> append here
 *   ## Tasks            ← <progress-entry> signals append a 4-section block here
 *
 * Other signal types (task-verified, task-complete, evaluation, and setup-time signals) do
 * NOT write to progress.md — those belong to the attempt aggregate (in `tasks.json`) or are
 * one-shot setup outputs.
 *
 * Concurrency model:
 *   - `Sink.emit` is fire-and-forget (synchronous). The sink enqueues each emission and a
 *     single in-flight worker drains the queue serially.
 *   - Each drain holds the supplied file lock so a second process emitting into the same
 *     `progress.md` cannot interleave. Lock-acquisition failures are surfaced via
 *     `console.warn` — the chain MUST NOT halt on contention; missed bullets are acceptable,
 *     a stuck pipeline is not.
 *   - `flush()` returns a promise that resolves once the queue drains. Used in tests and at
 *     chain end so the file content is observable.
 */

export interface ProgressFileSinkDeps {
  readonly progressFile: AbsolutePath;
  readonly lockFile: AbsolutePath;
  readonly locker: FileLocker;
  readonly clock?: () => Date;
  /**
   * Optional logger for non-fatal warnings (lock-failure, queue-cap drops). When undefined we
   * fall back to `console.warn` so the sink still surfaces issues in test-only contexts that
   * don't wire the harness logger.
   */
  readonly logger?: Logger;
}

export interface ProgressFileSink extends Sink<HarnessSignal> {
  /** Resolves when every emit so far has been written. Errors are swallowed by `emit`. */
  flush(): Promise<void>;
}

/**
 * Hard cap on queued signals waiting to be written to `progress.md`. The drain serialises on
 * the file lock; if that lock is contended (a second process emitting into the same file) or
 * the underlying filesystem stalls, signals would otherwise pile up indefinitely — over a
 * multi-hour Implement run that's a real memory leak.
 *
 * 10_000 is well above the realistic emit rate (a typical implement task emits <100 signals)
 * and small enough to cap memory at a few MB even if every signal carries a multi-KB body.
 * When the cap trips we drop the OLDEST entries — the most recent signals are usually the
 * most useful for resume / postmortem.
 */
const MAX_QUEUE_DEPTH = 10_000;

export const createProgressFileSink = (deps: ProgressFileSinkDeps): ProgressFileSink => {
  const queue: HarnessSignal[] = [];
  let draining: Promise<void> | undefined;
  let droppedSinceLastWarn = 0;
  const clock = deps.clock ?? ((): Date => new Date());
  const log = deps.logger?.named('progress-file-sink');
  const warn = (message: string, meta?: Readonly<Record<string, unknown>>): void => {
    if (log !== undefined) log.warn(message, meta);
    else console.warn(`[progress-file-sink] ${message}`, meta ?? '');
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const next = queue.shift()!;
      const rendered = renderSignal(next, clock);
      if (rendered === undefined) continue;
      const locked = await deps.locker.withLock(deps.lockFile, async () => {
        await mergeSection(String(deps.progressFile), rendered);
      });
      if (!locked.ok) {
        // Best-effort: log and move on. The chain must not halt on lock contention.
        warn('write failed', { error: locked.error.message });
      }
    }
  };

  const kick = (): void => {
    if (draining !== undefined) return;
    draining = drain().finally(() => {
      draining = undefined;
    });
  };

  return {
    emit(signal: HarnessSignal): void {
      if (queue.length >= MAX_QUEUE_DEPTH) {
        queue.shift();
        droppedSinceLastWarn++;
        if (droppedSinceLastWarn === 1 || droppedSinceLastWarn % 100 === 0) {
          warn('queue at cap — dropping oldest signal (locker stalled?)', {
            cap: MAX_QUEUE_DEPTH,
            droppedSoFar: droppedSinceLastWarn,
          });
        }
      }
      queue.push(signal);
      kick();
    },
    async flush(): Promise<void> {
      while (queue.length > 0 || draining !== undefined) {
        if (draining !== undefined) await draining;
        else kick();
      }
    },
  };
};

type SectionId = 'Learnings' | 'Decisions' | 'Activity' | 'Tasks';

interface Rendered {
  readonly section: SectionId;
  readonly body: string;
}

const renderSignal = (signal: HarnessSignal, clock: () => Date): Rendered | undefined => {
  const ts = clock().toISOString();
  switch (signal.type) {
    case 'learning':
      return { section: 'Learnings', body: `- ${ts} — ${oneLine(signal.text)}` };
    case 'decision':
      return { section: 'Decisions', body: `- ${ts} — ${oneLine(signal.text)}` };
    case 'change':
      return { section: 'Activity', body: `- ${ts} — change: ${oneLine(signal.text)}` };
    case 'note':
      return { section: 'Activity', body: `- ${ts} — note: ${oneLine(signal.text)}` };
    case 'progress':
      return { section: 'Activity', body: `- ${ts} — progress: ${oneLine(signal.summary)}` };
    case 'task-blocked':
      return { section: 'Activity', body: `- ${ts} — **task blocked:** ${oneLine(signal.reason)}` };
    case 'progress-entry':
      return { section: 'Tasks', body: renderProgressEntry(signal, ts) };
    case 'task-verified':
    case 'task-complete':
    case 'evaluation':
    case 'check-script-discovery':
    case 'agents-md-proposal':
    case 'setup-script':
    case 'verify-script':
    case 'setup-skill-proposal':
    case 'verify-skill-proposal':
    case 'skill-suggestions':
    case 'commit-message':
      return undefined;
    default: {
      const _exhaustive: never = signal;
      void _exhaustive;
      return undefined;
    }
  }
};

const renderProgressEntry = (signal: ProgressEntrySignal, ts: string): string => {
  const heading = signal.task.trim().length > 0 ? signal.task.trim() : '(unnamed task)';
  const files = signal.filesChanged.length === 0 ? '_None._' : signal.filesChanged.map((f) => `- ${f}`).join('\n');
  const learnings = signal.learnings.trim().length > 0 ? signal.learnings.trim() : '_None._';
  const notes = signal.notesForNext.trim().length > 0 ? signal.notesForNext.trim() : '_None._';
  // Leading blank line so back-to-back entries get visual separation.
  return [
    '',
    `### ${ts} — ${heading}`,
    '',
    '**Files changed**',
    '',
    files,
    '',
    '**Learnings**',
    '',
    learnings,
    '',
    '**Notes for next**',
    '',
    notes,
  ].join('\n');
};

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

const TITLE = '# Sprint progress';
const HEADINGS: readonly SectionId[] = ['Learnings', 'Decisions', 'Activity', 'Tasks'];
const TEMPLATE = `${TITLE}\n\n${HEADINGS.map((h) => `## ${h}\n`).join('\n')}`;

const mergeSection = async (path: string, rendered: Rendered): Promise<void> => {
  await fs.mkdir(dirname(path), { recursive: true });
  let current: string;
  try {
    current = await fs.readFile(path, 'utf8');
  } catch (err) {
    if (!isNodeErrnoCode(err, 'ENOENT')) throw err;
    current = TEMPLATE;
  }

  const ensured = ensureHeadings(current);
  const next = appendUnderHeading(ensured, rendered.section, rendered.body);

  const tmp = `${path}.tmp.${String(process.pid)}.${String(Date.now())}`;
  await fs.writeFile(tmp, next, 'utf8');
  await fs.rename(tmp, path);
};

const ensureHeadings = (current: string): string => {
  const missing = HEADINGS.filter((h) => !new RegExp(`^##\\s+${h}\\s*$`, 'm').test(current));
  if (missing.length === 0) return current;
  const trimmed = current.trim();
  if (trimmed.length === 0 || trimmed === '#' || trimmed === TITLE) return TEMPLATE;
  return `${TEMPLATE}\n## Notes\n\n${trimmed}\n`;
};

const appendUnderHeading = (text: string, heading: SectionId, body: string): string => {
  const headingRe = new RegExp(`^(##\\s+${heading}\\s*)$`, 'm');
  const match = headingRe.exec(text);
  if (match === null) return `${text}\n${body}\n`;
  const insertAt = match.index + match[0].length;
  const tail = text.slice(insertAt);
  const nextHeadingMatch = /\n##\s+/.exec(tail);
  const sectionEndOffset = nextHeadingMatch === null ? tail.length : nextHeadingMatch.index;
  const sectionBody = tail.slice(0, sectionEndOffset);
  const rest = tail.slice(sectionEndOffset);
  const newSectionBody = sectionBody.endsWith('\n') ? `${sectionBody}${body}\n` : `${sectionBody}\n${body}\n`;
  const collapsed = newSectionBody.replace(/^(\s*\n)+/, '\n\n');
  return `${text.slice(0, insertAt)}${collapsed}${rest}`;
};
