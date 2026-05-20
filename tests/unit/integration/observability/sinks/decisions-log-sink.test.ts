/**
 * decisions-log-sink — append-only contract for `<sprintDir>/decisions.log`.
 *
 * Pins:
 *  - Only `<decision>` signals produce a write — every other signal is silently ignored.
 *  - On-disk format is `<iso> <taskId-or-?> <commitSha-or-?> <text>\n` (positional, space-sep).
 *  - `resolveContext` is invoked lazily per signal so a tracker that updates between
 *    emissions reflects the right taskId on each line.
 *  - Multi-line decision bodies collapse to a single line so the file stays grep-friendly.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DecisionSignal, HarnessSignal, LearningSignal, NoteSignal } from '@src/domain/signal.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createDecisionsLogSink } from '@src/integration/observability/sinks/decisions-log-sink.ts';

const absPath = (p: string): AbsolutePath => {
  const parsed = AbsolutePath.parse(p);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const iso = (s: string): IsoTimestamp => {
  const parsed = IsoTimestamp.parse(s);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const decision = (text: string, at: string): DecisionSignal => ({
  type: 'decision',
  text,
  timestamp: iso(at),
});

const learning = (text: string, at: string): LearningSignal => ({
  type: 'learning',
  text,
  timestamp: iso(at),
});

const note = (text: string, at: string): NoteSignal => ({
  type: 'note',
  text,
  timestamp: iso(at),
});

describe('createDecisionsLogSink', () => {
  let dir: string;
  let file: AbsolutePath;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ralphctl-decisions-'));
    file = absPath(join(dir, 'decisions.log'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one positional line per <decision> signal with task/commit columns', async () => {
    const sink = createDecisionsLogSink({
      file,
      resolveContext: () => ({ taskId: 'task-abc', commitSha: 'deadbee' }),
    });
    sink.emit(decision('chose X over Y because Z', '2026-05-21T10:00:00.000Z'));
    await sink.flush();

    const content = await readFile(String(file), 'utf8');
    expect(content).toBe('2026-05-21T10:00:00.000Z task-abc deadbee chose X over Y because Z\n');
  });

  it('renders missing context columns as `?` so the format stays positional', async () => {
    const sink = createDecisionsLogSink({ file, resolveContext: () => ({}) });
    sink.emit(decision('inferred default', '2026-05-21T10:00:00.000Z'));
    await sink.flush();

    const content = await readFile(String(file), 'utf8');
    expect(content).toBe('2026-05-21T10:00:00.000Z ? ? inferred default\n');
  });

  it('ignores non-decision signals — only `<decision>` produces a write', async () => {
    const sink = createDecisionsLogSink({ file, resolveContext: () => ({}) });
    sink.emit(learning('learning text', '2026-05-21T10:00:00.000Z'));
    sink.emit(note('note text', '2026-05-21T10:00:01.000Z') as HarnessSignal);
    await sink.flush();

    // No file was created because nothing was written.
    let stat;
    try {
      stat = await fs.stat(String(file));
    } catch {
      stat = undefined;
    }
    expect(stat).toBeUndefined();
  });

  it('invokes resolveContext lazily so a per-task tracker reflects the right taskId on each line', async () => {
    let currentTaskId: string | undefined;
    const sink = createDecisionsLogSink({
      file,
      resolveContext: () => (currentTaskId !== undefined ? { taskId: currentTaskId } : {}),
    });
    currentTaskId = 'task-1';
    sink.emit(decision('first', '2026-05-21T10:00:00.000Z'));
    currentTaskId = 'task-2';
    sink.emit(decision('second', '2026-05-21T10:00:01.000Z'));
    await sink.flush();

    const content = await readFile(String(file), 'utf8');
    expect(content).toBe(
      ['2026-05-21T10:00:00.000Z task-1 ? first', '2026-05-21T10:00:01.000Z task-2 ? second', ''].join('\n')
    );
  });

  it('collapses interior whitespace so multi-line decision bodies stay single-line', async () => {
    const sink = createDecisionsLogSink({ file, resolveContext: () => ({}) });
    sink.emit(decision('line one\n  line two\n\tline three', '2026-05-21T10:00:00.000Z'));
    await sink.flush();

    const content = await readFile(String(file), 'utf8');
    expect(content).toBe('2026-05-21T10:00:00.000Z ? ? line one line two line three\n');
  });
});
