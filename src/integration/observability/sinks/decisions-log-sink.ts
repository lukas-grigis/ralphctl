import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { Sink } from '@src/business/observability/sink.ts';

/**
 * Append-only single-line log of every `<decision>` signal the harness sees during a sprint.
 * Writes to `<sprintDir>/decisions.log`. One decision per line; the canonical format is:
 *
 *     <iso> <task-id> <commitSha-or-?> <text>
 *
 * The line is space-separated and the text itself is collapsed to a single space-joined string
 * so each entry stays grep-friendly. The columns are deliberately positional (no JSON) so a
 * reader can `awk` / `cut` the file from a shell without a parser.
 *
 * Concurrency: writes go through a serial drain queue. `fs.appendFile` is atomic per-call on
 * POSIX for chunks within PIPE_BUF, but each line is unbounded (a long decision body can
 * exceed the kernel guarantee) so we serialize to avoid interleaved bytes.
 *
 * Failure mode: append failures are silenced. The decisions log is a derived artefact; a
 * disk-write error must NEVER take down the chain. The sink does not currently re-publish
 * a degradation event — `<sprintDir>/chain.log` is the authoritative postmortem trace and
 * already has its own degradation contract.
 *
 * This sink is wired as one branch of a `broadcastSink<HarnessSignal>` alongside the existing
 * TUI bus sink. The TUI does not subscribe to the on-disk file — it continues to read from
 * the in-memory harness bus.
 */

/**
 * Per-decision tagging context resolved by the caller at decision-write time. The sink itself
 * does not see the chain context (taskId / commit sha), so the caller supplies a getter that
 * the sink invokes lazily on every `<decision>` signal.
 */
export interface DecisionContext {
  /** Active task id when the decision was emitted, if any. `?` is written when undefined. */
  readonly taskId?: string;
  /** Latest known commit sha for the active task, if any. `?` is written when undefined. */
  readonly commitSha?: string;
}

export interface DecisionsLogSinkDeps {
  /** Absolute path to `<sprintDir>/decisions.log`. Parent directory is created on first write. */
  readonly file: AbsolutePath;
  /**
   * Resolver invoked once per `<decision>` signal to produce the per-row tag columns.
   * Returns `{}` when no context is available — `?` columns make the missing case explicit
   * in the on-disk format.
   */
  readonly resolveContext: () => DecisionContext;
}

export interface DecisionsLogSink extends Sink<HarnessSignal> {
  /** Resolves once every queued write has been flushed. Errors are swallowed. */
  flush(): Promise<void>;
}

const MISSING = '?';

/**
 * Defence-in-depth cap on the body length actually written to disk. The decision parser
 * already drops runaway matches (`MAX_DECISION_BODY_CHARS` in
 * `integration/ai/signals/decision/parser.ts`); this sink-side slice ensures a non-parser
 * source that ever feeds a `DecisionSignal` directly cannot pollute `decisions.log` with
 * an unbounded blob — and bounds the on-disk line length for grep / awk consumers.
 */
const SINK_BODY_CAP = 500;

/**
 * Collapse interior whitespace so the text occupies exactly one line in the log file, then
 * clamp to {@link SINK_BODY_CAP} so a misbehaving upstream cannot write an unbounded line.
 */
const collapseToSingleLine = (text: string): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > SINK_BODY_CAP ? collapsed.slice(0, SINK_BODY_CAP) : collapsed;
};

const formatLine = (timestamp: string, ctx: DecisionContext, text: string): string => {
  const taskId = ctx.taskId !== undefined && ctx.taskId.length > 0 ? ctx.taskId : MISSING;
  const commitSha = ctx.commitSha !== undefined && ctx.commitSha.length > 0 ? ctx.commitSha : MISSING;
  const safeText = collapseToSingleLine(text);
  return `${timestamp} ${taskId} ${commitSha} ${safeText}\n`;
};

export const createDecisionsLogSink = (deps: DecisionsLogSinkDeps): DecisionsLogSink => {
  const queue: string[] = [];
  let draining: Promise<void> | undefined;
  let dirEnsured = false;

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) continue;
      try {
        if (!dirEnsured) {
          await fs.mkdir(dirname(String(deps.file)), { recursive: true });
          dirEnsured = true;
        }
        await fs.appendFile(String(deps.file), next, 'utf8');
      } catch {
        // Best-effort. The decisions log is a derived artefact; a disk-write error must not
        // take down the chain. The TUI still reflects the decision via the harness signal bus.
      }
    }
    draining = undefined;
  };

  const enqueue = (line: string): void => {
    queue.push(line);
    if (draining === undefined) draining = drain();
  };

  return {
    emit(signal: HarnessSignal): void {
      if (signal.type !== 'decision') return;
      const ctx = deps.resolveContext();
      enqueue(formatLine(String(signal.timestamp), ctx, signal.text));
    },
    async flush(): Promise<void> {
      if (draining !== undefined) await draining;
    },
  };
};
