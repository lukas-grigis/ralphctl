/**
 * Integration tests for the migration apply step (Wave 2) — THE safety surface. The user was badly
 * burned by a past migration, so these assert the engine is backup-first, crash-safe, idempotent, and
 * strictly scoped to `data/` (config/ + state/ are never touched).
 *
 * Covers: correct renames; backup created BEFORE any rename; learnings.md backfilled; marker stamped
 * with BOTH fields; idempotent re-run; lock-held refusal (nothing touched); crash-safety (a rename
 * that throws ⇒ marker NOT stamped ⇒ a re-run completes); the tree stays readable via the Wave-1
 * tolerant resolver throughout; and config/ + state/ byte-identical before/after a full apply.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { recordingWriteFile } from '@tests/fixtures/recording-write-file.ts';
import { dryRun } from '@src/integration/persistence/data-migration/dry-run.ts';
import { apply, type ApplyCtx } from '@src/integration/persistence/data-migration/apply.ts';
import { readDataVersion } from '@src/integration/persistence/data-migration/version-marker.ts';
import { resolveSprintDir, resolveProjectPath } from '@src/integration/persistence/storage.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import {
  freshId,
  seedLegacyMemory,
  seedLegacyProject,
  seedLegacySprint,
  snapshotContents,
} from '@tests/integration/persistence/data-migration/_seed.ts';

let appRoot: string;
let dataRoot: string;
let stateRoot: string;
let configRoot: string;
let writer: ReturnType<typeof recordingWriteFile>;

beforeEach(async () => {
  appRoot = await fs.mkdtemp(join(tmpdir(), 'ralph-apply-'));
  dataRoot = join(appRoot, 'data');
  stateRoot = join(appRoot, 'state');
  configRoot = join(appRoot, 'config');
  await fs.mkdir(join(dataRoot, 'projects'), { recursive: true });
  await fs.mkdir(join(dataRoot, 'sprints'), { recursive: true });
  await fs.mkdir(join(dataRoot, 'memory'), { recursive: true });
  await fs.mkdir(join(stateRoot, 'locks'), { recursive: true });
  await fs.mkdir(configRoot, { recursive: true });
  await fs.writeFile(join(configRoot, 'settings.json'), '{"ai":{}}', 'utf8');
  writer = recordingWriteFile();
});

afterEach(async () => {
  await fs.rm(appRoot, { recursive: true, force: true });
});

const ctx = (): ApplyCtx => ({
  timestamp: '2026-06-19T10:00:00.000Z',
  appVersion: '0.12.1',
  stateRoot: absolutePath(stateRoot),
  // Trivial renderer: any non-empty ledger body produces a one-line md so the backfill writes.
  renderLearnings: (body) => (body.trim().length > 0 ? `# Learnings\n\n${body}` : '# Learnings\n\n_empty_'),
  writeFile: writer.fn,
});

const runFull = async () => {
  const report = await dryRun(absolutePath(dataRoot));
  return apply(absolutePath(dataRoot), report, ctx());
};

describe('apply — happy path', () => {
  it('renames every legacy entry, backfills learnings.md, stamps the marker with both fields', async () => {
    const pid = freshId();
    const sid = freshId();
    await seedLegacyProject(dataRoot, pid, 'alpha');
    await seedLegacySprint(dataRoot, sid, 'beta');
    await seedLegacyMemory(dataRoot, pid, '{"text":"x"}\n');

    const result = await runFull();
    expect(result.kind).toBe('ok');

    // Renamed to the canonical slugged names.
    await expect(fs.stat(join(dataRoot, 'projects', `${pid}--alpha.json`))).resolves.toBeTruthy();
    await expect(fs.stat(join(dataRoot, 'sprints', `${sid}--beta`))).resolves.toBeTruthy();
    await expect(fs.stat(join(dataRoot, 'memory', `${pid}--alpha`))).resolves.toBeTruthy();
    // Legacy names gone.
    await expect(fs.stat(join(dataRoot, 'projects', `${pid}.json`))).rejects.toThrow();

    // learnings.md backfilled next to the (renamed) ledger.
    const mdPath = absolutePath(join(dataRoot, 'memory', `${pid}--alpha`, 'learnings.md'));
    expect(writer.read(mdPath)).toContain('# Learnings');

    // Marker stamped with both fields.
    expect(await readDataVersion(absolutePath(dataRoot))).toEqual({
      dataVersion: 2,
      lastWrittenByAppVersion: '0.12.1',
    });
  });

  it('backup is created BEFORE renames (and contains the ORIGINAL legacy names)', async () => {
    const sid = freshId();
    await seedLegacySprint(dataRoot, sid, 'beta');

    const result = await runFull();
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    // The backup holds the pre-migration (legacy) layout.
    await expect(fs.stat(join(result.backupPath, 'sprints', sid))).resolves.toBeTruthy();
    await expect(fs.stat(join(result.backupPath, 'sprints', `${sid}--beta`))).rejects.toThrow();
  });

  it('the tree stays readable via the Wave-1 tolerant resolver before AND after migration', async () => {
    const pid = freshId();
    const sid = freshId();
    await seedLegacyProject(dataRoot, pid, 'alpha');
    await seedLegacySprint(dataRoot, sid, 'beta');

    const projectId = ProjectId.parse(pid);
    const sprintId = SprintId.parse(sid);
    if (!projectId.ok || !sprintId.ok) throw new Error('bad id');

    // Before: legacy names resolve.
    expect(await resolveProjectPath(absolutePath(dataRoot), projectId.value)).toContain(`${pid}.json`);
    expect(await resolveSprintDir(absolutePath(dataRoot), sprintId.value)).toContain(sid);

    await runFull();

    // After: the SAME ids resolve to the new slugged names.
    expect(await resolveProjectPath(absolutePath(dataRoot), projectId.value)).toContain(`${pid}--alpha.json`);
    expect(await resolveSprintDir(absolutePath(dataRoot), sprintId.value)).toContain(`${sid}--beta`);
  });
});

describe('apply — idempotency', () => {
  it('a second run is a no-op: marker unchanged, no duplicate dirs', async () => {
    const sid = freshId();
    await seedLegacySprint(dataRoot, sid, 'beta');

    const first = await runFull();
    expect(first.kind).toBe('ok');

    const treeAfterFirst = await snapshotContents(dataRoot);
    const second = await runFull();
    expect(second.kind).toBe('ok');
    if (second.kind === 'ok') expect(second.applied.every((a) => a.status === 'skipped')).toBe(true);

    expect(await snapshotContents(dataRoot)).toEqual(treeAfterFirst);
  });
});

describe('apply — lock held', () => {
  it('refuses and touches NOTHING when a fresh lock is held', async () => {
    const sid = freshId();
    await seedLegacySprint(dataRoot, sid, 'beta');
    await fs.mkdir(join(stateRoot, 'locks', 'repo-held.lock'), { recursive: true });

    const before = await snapshotContents(dataRoot);
    const result = await runFull();
    expect(result.kind).toBe('lock-held');
    expect(await snapshotContents(dataRoot)).toEqual(before);
    // Marker never stamped.
    expect((await readDataVersion(absolutePath(dataRoot))).dataVersion).toBe(1);
  });
});

describe('apply — crash safety', () => {
  it('a rename that throws ⇒ marker NOT stamped ⇒ a clean re-run finishes', async () => {
    const a = freshId();
    const b = freshId();
    await seedLegacySprint(dataRoot, a, 'one');
    await seedLegacySprint(dataRoot, b, 'two');

    const report = await dryRun(absolutePath(dataRoot));
    expect(report.planned).toHaveLength(2);

    // Simulate a crash mid-rename: the SECOND rename throws a real I/O fault. Capture the real
    // rename first so call 1 still moves a directory for real.
    const realRename = fs.rename.bind(fs);
    let calls = 0;
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((async (from: string, to: string) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      return realRename(from, to);
    }) as typeof fs.rename);

    const failed = await apply(absolutePath(dataRoot), report, ctx());
    renameSpy.mockRestore();

    expect(failed.kind).toBe('failed');
    // The marker was NOT stamped — a re-run must resume.
    expect((await readDataVersion(absolutePath(dataRoot))).dataVersion).toBe(1);
    // The tree is a readable mix (one renamed, one still legacy) — tolerant readers cover it.
    const sprintA = SprintId.parse(a);
    const sprintB = SprintId.parse(b);
    if (!sprintA.ok || !sprintB.ok) throw new Error('bad id');
    expect(await resolveSprintDir(absolutePath(dataRoot), sprintA.value)).toBeTruthy();
    expect(await resolveSprintDir(absolutePath(dataRoot), sprintB.value)).toBeTruthy();

    // Re-run with rename working → completes and stamps.
    const resume = await runFull();
    expect(resume.kind).toBe('ok');
    expect((await readDataVersion(absolutePath(dataRoot))).dataVersion).toBe(2);
    await expect(fs.stat(join(dataRoot, 'sprints', `${a}--one`))).resolves.toBeTruthy();
    await expect(fs.stat(join(dataRoot, 'sprints', `${b}--two`))).resolves.toBeTruthy();
  });
});

describe('apply — scope', () => {
  it('config/ and state/ are byte-identical before and after a full apply', async () => {
    await seedLegacySprint(dataRoot, freshId(), 'beta');

    const configBefore = await snapshotContents(configRoot);
    const stateBefore = await snapshotContents(stateRoot);

    await runFull();

    expect(await snapshotContents(configRoot)).toEqual(configBefore);
    expect(await snapshotContents(stateRoot)).toEqual(stateBefore);
  });
});
