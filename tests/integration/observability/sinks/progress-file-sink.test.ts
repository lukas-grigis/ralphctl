import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { createProgressFileSink } from '@src/integration/observability/sinks/progress-file-sink.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

const path = (root: string, name: string): AbsolutePath => {
  const r = AbsolutePath.parse(join(root, name));
  if (!r.ok) throw new Error('test setup');
  return r.value;
};

const fixedClock = (iso: string) => (): Date => new Date(iso);

describe('createProgressFileSink', () => {
  let root: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-v2-progress-'));
    root = await realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('initializes progress.md with all three pinned sections on first emit', async () => {
    const sink = createProgressFileSink({
      progressFile: path(root, 'progress.md'),
      lockFile: path(root, 'progress.md.lock'),
      locker: createFileLocker(),
      clock: fixedClock('2026-05-09T10:00:00.000Z'),
    });
    sink.emit({ type: 'note', text: 'hello world', timestamp: NOW });
    await sink.flush();

    const content = await fs.readFile(join(root, 'progress.md'), 'utf8');
    expect(content).toContain('# Sprint progress');
    expect(content).toContain('## Learnings');
    expect(content).toContain('## Decisions');
    expect(content).toContain('## Activity');
    expect(content).toContain('note: hello world');
  });

  it('appends learnings under the Learnings heading', async () => {
    const sink = createProgressFileSink({
      progressFile: path(root, 'progress.md'),
      lockFile: path(root, 'progress.md.lock'),
      locker: createFileLocker(),
      clock: fixedClock('2026-05-09T10:00:00.000Z'),
    });
    sink.emit({ type: 'learning', text: 'Codex CLI uses -C for cwd', timestamp: NOW });
    sink.emit({ type: 'learning', text: 'AbsolutePath disallows ~', timestamp: NOW });
    await sink.flush();

    const content = await fs.readFile(join(root, 'progress.md'), 'utf8');
    const learningsBlock = content.split('## Decisions')[0] ?? '';
    expect(learningsBlock).toContain('Codex CLI uses -C for cwd');
    expect(learningsBlock).toContain('AbsolutePath disallows ~');
  });

  it('appends decisions under the Decisions heading without leaking into other sections', async () => {
    const sink = createProgressFileSink({
      progressFile: path(root, 'progress.md'),
      lockFile: path(root, 'progress.md.lock'),
      locker: createFileLocker(),
      clock: fixedClock('2026-05-09T10:00:00.000Z'),
    });
    sink.emit({ type: 'decision', text: 'lift v1 FileLocker over proper-lockfile dep', timestamp: NOW });
    await sink.flush();

    const content = await fs.readFile(join(root, 'progress.md'), 'utf8');
    const decisionsIdx = content.indexOf('## Decisions');
    const activityIdx = content.indexOf('## Activity');
    const decisionsBlock = content.slice(decisionsIdx, activityIdx);
    expect(decisionsBlock).toContain('lift v1 FileLocker');
  });

  it('routes change / note / progress / task-blocked into Activity', async () => {
    const sink = createProgressFileSink({
      progressFile: path(root, 'progress.md'),
      lockFile: path(root, 'progress.md.lock'),
      locker: createFileLocker(),
      clock: fixedClock('2026-05-09T10:00:00.000Z'),
    });
    sink.emit({ type: 'change', text: 'added FileLocker', timestamp: NOW });
    sink.emit({ type: 'note', text: 'cwd via -C', timestamp: NOW });
    sink.emit({ type: 'progress', summary: 'tests pass', timestamp: NOW });
    sink.emit({ type: 'task-blocked', reason: 'missing dep X', timestamp: NOW });
    await sink.flush();

    const content = await fs.readFile(join(root, 'progress.md'), 'utf8');
    const activityIdx = content.indexOf('## Activity');
    const activityBlock = content.slice(activityIdx);
    expect(activityBlock).toMatch(/change: added FileLocker/);
    expect(activityBlock).toMatch(/note: cwd via -C/);
    expect(activityBlock).toMatch(/progress: tests pass/);
    expect(activityBlock).toMatch(/\*\*task blocked:\*\* missing dep X/);
  });

  it('skips signal types that belong to attempt persistence (no write)', async () => {
    const sink = createProgressFileSink({
      progressFile: path(root, 'progress.md'),
      lockFile: path(root, 'progress.md.lock'),
      locker: createFileLocker(),
      clock: fixedClock('2026-05-09T10:00:00.000Z'),
    });
    const skipped: HarnessSignal[] = [
      { type: 'task-verified', output: 'all green', timestamp: NOW },
      { type: 'task-complete', timestamp: NOW },
      { type: 'evaluation', status: 'passed', dimensions: [], timestamp: NOW },
    ];
    for (const s of skipped) sink.emit(s);
    await sink.flush();

    // File should not exist (no writes happened).
    await expect(fs.access(join(root, 'progress.md'))).rejects.toThrow();
  });

  it('serialises concurrent emits — final file contains both bullets in order', async () => {
    const locker = createFileLocker({ retryDelayMs: 1 });
    const sink = createProgressFileSink({
      progressFile: path(root, 'progress.md'),
      lockFile: path(root, 'progress.md.lock'),
      locker,
      clock: fixedClock('2026-05-09T10:00:00.000Z'),
    });
    for (let i = 0; i < 10; i++) sink.emit({ type: 'change', text: `change-${String(i)}`, timestamp: NOW });
    await sink.flush();

    const content = await fs.readFile(join(root, 'progress.md'), 'utf8');
    for (let i = 0; i < 10; i++) expect(content).toContain(`change-${String(i)}`);
    // Order preserved: change-0 appears before change-9.
    expect(content.indexOf('change-0')).toBeLessThan(content.indexOf('change-9'));
  });

  it('preserves existing pre-template content as a Notes tail when initializing', async () => {
    const sink = createProgressFileSink({
      progressFile: path(root, 'progress.md'),
      lockFile: path(root, 'progress.md.lock'),
      locker: createFileLocker(),
      clock: fixedClock('2026-05-09T10:00:00.000Z'),
    });
    await fs.writeFile(join(root, 'progress.md'), 'pre-existing notes from human\n');
    sink.emit({ type: 'learning', text: 'kept', timestamp: NOW });
    await sink.flush();

    const content = await fs.readFile(join(root, 'progress.md'), 'utf8');
    expect(content).toContain('## Notes');
    expect(content).toContain('pre-existing notes from human');
    expect(content).toContain('kept');
  });

  it('collapses internal whitespace in bullet bodies', async () => {
    const sink = createProgressFileSink({
      progressFile: path(root, 'progress.md'),
      lockFile: path(root, 'progress.md.lock'),
      locker: createFileLocker(),
      clock: fixedClock('2026-05-09T10:00:00.000Z'),
    });
    sink.emit({ type: 'learning', text: 'multi\n\nline   text', timestamp: NOW });
    await sink.flush();

    const content = await fs.readFile(join(root, 'progress.md'), 'utf8');
    expect(content).toContain('multi line text');
  });

  it('renders progress-entry as a 4-section block under ## Tasks', async () => {
    const sink = createProgressFileSink({
      progressFile: path(root, 'progress.md'),
      lockFile: path(root, 'progress.md.lock'),
      locker: createFileLocker(),
      clock: fixedClock('2026-05-14T11:00:00.000Z'),
    });
    sink.emit({
      type: 'progress-entry',
      task: 'Add user-id index',
      filesChanged: ['app/db.ts', 'migrations/0042_index.sql'],
      learnings: 'sqlite expects explicit pragmas',
      notesForNext: 'still need to wire the ORM mapping',
      timestamp: NOW,
    });
    await sink.flush();

    const content = await fs.readFile(join(root, 'progress.md'), 'utf8');
    expect(content).toContain('## Tasks');
    expect(content).toContain('### 2026-05-14T11:00:00.000Z — Add user-id index');
    expect(content).toContain('**Files changed**');
    expect(content).toContain('- app/db.ts');
    expect(content).toContain('- migrations/0042_index.sql');
    expect(content).toContain('**Learnings**');
    expect(content).toContain('sqlite expects explicit pragmas');
    expect(content).toContain('**Notes for next**');
    expect(content).toContain('still need to wire the ORM mapping');
    // The 4-section block must appear under the Tasks heading, NOT under Activity.
    const tasksIdx = content.indexOf('## Tasks');
    const entryIdx = content.indexOf('Add user-id index');
    expect(entryIdx).toBeGreaterThan(tasksIdx);
  });

  it('renders _None._ for empty files / learnings / notes in a progress-entry', async () => {
    const sink = createProgressFileSink({
      progressFile: path(root, 'progress.md'),
      lockFile: path(root, 'progress.md.lock'),
      locker: createFileLocker(),
      clock: fixedClock('2026-05-14T11:00:00.000Z'),
    });
    sink.emit({
      type: 'progress-entry',
      task: 'investigative task',
      filesChanged: [],
      learnings: '',
      notesForNext: '',
      timestamp: NOW,
    });
    await sink.flush();

    const content = await fs.readFile(join(root, 'progress.md'), 'utf8');
    // Every section is present, all three of the optional ones collapsed to _None._
    expect(content).toContain('### 2026-05-14T11:00:00.000Z — investigative task');
    expect(content.match(/_None\._/g)?.length).toBe(3);
  });

  it('drops the oldest signal and routes the warning through the logger when the queue exceeds the cap', async () => {
    // A stalled locker (one that never returns) lets us load the queue past its cap. The sink
    // should drop oldest entries and emit a `warn` to the supplied logger so an operator can
    // see the lock contention even when console output isn't captured.
    const stallingLocker = {
      // Return a never-resolving promise — the queue stays unflushed for the lifetime of the
      // test so we can exercise the cap.
      withLock: <T>(): Promise<{ ok: true; value: T } | { ok: false; error: Error }> => new Promise(() => undefined),
    };
    const warns: Array<{ message: string; meta?: Readonly<Record<string, unknown>> }> = [];
    const fakeLogger = {
      named: () => fakeLogger,
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string, meta?: Readonly<Record<string, unknown>>) =>
        warns.push({ message, ...(meta !== undefined ? { meta } : {}) }),
      error: () => undefined,
    };

    const sink = createProgressFileSink({
      progressFile: path(root, 'progress.md'),
      lockFile: path(root, 'progress.md.lock'),
      // Cast: we only care about contract conformance for `withLock`; the real FileLocker
      // returns Result, our stub fakes a forever-pending lock acquisition.
      locker: stallingLocker as unknown as ReturnType<typeof createFileLocker>,
      clock: fixedClock('2026-05-09T10:00:00.000Z'),
      logger: fakeLogger as unknown as NonNullable<Parameters<typeof createProgressFileSink>[0]['logger']>,
    });

    // First emit kicks the drain, which synchronously shifts one signal before awaiting the
    // stalled lock. So we need cap + 2 emits to push the queue past the cap from the caller's
    // side. We add a bit more to also verify the every-100th-drop heartbeat warning.
    for (let i = 0; i < 10_300; i++) sink.emit({ type: 'note', text: `n=${String(i)}`, timestamp: NOW });

    // First drop must have fired one warning with the cap details.
    expect(warns.length).toBeGreaterThanOrEqual(1);
    const first = warns[0];
    expect(first?.message).toMatch(/queue at cap/);
    expect((first?.meta as { cap?: number } | undefined)?.cap).toBe(10_000);
  });
});
