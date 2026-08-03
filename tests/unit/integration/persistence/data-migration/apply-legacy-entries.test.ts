/**
 * Characterization test for `apply()` against a tmpdir seeded with legacy bare-id entries across
 * every family (project / sprint / memory), written BEFORE decomposing `backfillLearningsMd` and
 * `apply`'s internals into smaller named steps. This is the safety net for that refactor: a
 * migration regression is the one failure mode this project treats as never-acceptable, so these
 * assertions must keep passing, byte-for-byte, both before and after the decomposition.
 *
 * Never run against a real data root — every seed happens in a fresh `fs.mkdtemp` tree.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { recordingWriteFile } from '@tests/fixtures/recording-write-file.ts';
import { dryRun } from '@src/integration/persistence/data-migration/dry-run.ts';
import { apply, type ApplyCtx } from '@src/integration/persistence/data-migration/apply.ts';
import { readDataVersion } from '@src/integration/persistence/data-migration/version-marker.ts';
import {
  freshId,
  seedLegacyMemory,
  seedLegacyProject,
  seedLegacySprint,
  seedNewMemory,
} from '@tests/integration/persistence/data-migration/_seed.ts';

let appRoot: string;
let dataRoot: string;
let stateRoot: string;
let writer: ReturnType<typeof recordingWriteFile>;

beforeEach(async () => {
  appRoot = await fs.mkdtemp(join(tmpdir(), 'ralph-apply-legacy-'));
  dataRoot = join(appRoot, 'data');
  stateRoot = join(appRoot, 'state');
  await fs.mkdir(join(dataRoot, 'projects'), { recursive: true });
  await fs.mkdir(join(dataRoot, 'sprints'), { recursive: true });
  await fs.mkdir(join(dataRoot, 'memory'), { recursive: true });
  await fs.mkdir(join(stateRoot, 'locks'), { recursive: true });
  writer = recordingWriteFile();
});

afterEach(async () => {
  await fs.rm(appRoot, { recursive: true, force: true });
});

const ctx = (): ApplyCtx => ({
  timestamp: '2026-08-03T10:00:00.000Z',
  appVersion: '0.18.0',
  stateRoot: absolutePath(stateRoot),
  renderLearnings: (body) => (body.trim().length > 0 ? `# Learnings\n\n${body}` : undefined),
  mergeLearnings: (sluggedBody, legacyBody) => ({ ndjson: `${sluggedBody}${legacyBody}`, md: undefined }),
  writeFile: writer.fn,
});

describe('apply — legacy bare-id entries across every family (characterization)', () => {
  it('renames the legacy project/sprint/memory entries to their slugged form and stamps the marker', async () => {
    const pid = freshId();
    const sid = freshId();
    await seedLegacyProject(dataRoot, pid, 'alpha');
    await seedLegacySprint(dataRoot, sid, 'beta');
    await seedLegacyMemory(dataRoot, pid, '{"v":1,"id":"a","text":"note","promotedAt":null}\n');

    const report = await dryRun(absolutePath(dataRoot));
    const result = await apply(absolutePath(dataRoot), report, ctx());

    expect(result.kind).toBe('ok');
    await expect(fs.stat(join(dataRoot, 'projects', `${pid}--alpha.json`))).resolves.toBeTruthy();
    await expect(fs.stat(join(dataRoot, 'projects', `${pid}.json`))).rejects.toThrow();
    await expect(fs.stat(join(dataRoot, 'sprints', `${sid}--beta`))).resolves.toBeTruthy();
    await expect(fs.stat(join(dataRoot, 'sprints', sid))).rejects.toThrow();
    await expect(fs.stat(join(dataRoot, 'memory', `${pid}--alpha`))).resolves.toBeTruthy();
    await expect(fs.stat(join(dataRoot, 'memory', pid))).rejects.toThrow();

    expect(await readDataVersion(absolutePath(dataRoot))).toEqual({
      dataVersion: 2,
      lastWrittenByAppVersion: '0.18.0',
    });
  });

  it('backfills learnings.md for a renamed memory dir with a ledger but no mirror', async () => {
    const pid = freshId();
    await seedLegacyProject(dataRoot, pid, 'alpha');
    await seedLegacyMemory(dataRoot, pid, '{"v":1,"id":"a","text":"hello","promotedAt":null}\n');

    const report = await dryRun(absolutePath(dataRoot));
    const result = await apply(absolutePath(dataRoot), report, ctx());

    expect(result.kind).toBe('ok');
    const mdPath = absolutePath(join(dataRoot, 'memory', `${pid}--alpha`, 'learnings.md'));
    expect(writer.read(mdPath)).toContain('# Learnings');
    expect(writer.read(mdPath)).toContain('hello');
  });

  it('does not backfill when the renderer returns undefined for an empty ledger', async () => {
    const pid = freshId();
    await seedLegacyProject(dataRoot, pid, 'alpha');
    await seedLegacyMemory(dataRoot, pid, '');

    const report = await dryRun(absolutePath(dataRoot));
    const result = await apply(absolutePath(dataRoot), report, ctx());

    expect(result.kind).toBe('ok');
    const mdPath = absolutePath(join(dataRoot, 'memory', `${pid}--alpha`, 'learnings.md'));
    expect(writer.read(mdPath)).toBeUndefined();
  });

  it('does not backfill a memory dir that already has a learnings.md mirror', async () => {
    const pid = freshId();
    await seedNewMemory(dataRoot, pid, 'alpha', '{"v":1,"id":"a","text":"x","promotedAt":null}\n');
    await fs.writeFile(join(dataRoot, 'memory', `${pid}--alpha`, 'learnings.md'), '# already there\n', 'utf8');

    const report = await dryRun(absolutePath(dataRoot));
    const result = await apply(absolutePath(dataRoot), report, ctx());

    expect(result.kind).toBe('ok');
    const mdPath = absolutePath(join(dataRoot, 'memory', `${pid}--alpha`, 'learnings.md'));
    // Never written through the injected writer — the pre-existing mirror is left alone.
    expect(writer.read(mdPath)).toBeUndefined();
  });

  it('skips backfilling a ledger past the byte ceiling (OOM guard)', async () => {
    const pid = freshId();
    await seedNewMemory(dataRoot, pid, 'alpha', '{"v":1,"id":"a","text":"x","promotedAt":null}\n');
    const ledger = join(dataRoot, 'memory', `${pid}--alpha`, 'learnings.ndjson');
    await fs.truncate(ledger, 50 * 1024 * 1024 + 1);

    const report = await dryRun(absolutePath(dataRoot));
    const result = await apply(absolutePath(dataRoot), report, ctx());

    expect(result.kind).toBe('ok');
    const mdPath = absolutePath(join(dataRoot, 'memory', `${pid}--alpha`, 'learnings.md'));
    expect(writer.read(mdPath)).toBeUndefined();
  });

  it('skips backfilling through an untrusted memory entry name (symlink redirect guard)', async () => {
    const pid = freshId();
    await seedNewMemory(dataRoot, pid, 'alpha', '{"v":1,"id":"a","text":"x","promotedAt":null}\n');
    const outside = join(appRoot, 'outside-target');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(join(outside, 'learnings.ndjson'), '{"v":1,"id":"z","text":"evil","promotedAt":null}\n', 'utf8');
    await fs.symlink(outside, join(dataRoot, 'memory', 'not-a-uuid'), 'dir');

    const report = await dryRun(absolutePath(dataRoot));
    const result = await apply(absolutePath(dataRoot), report, ctx());

    expect(result.kind).toBe('ok');
    expect(writer.read(absolutePath(join(dataRoot, 'memory', `${pid}--alpha`, 'learnings.md')))).toContain(
      '# Learnings'
    );
    expect(writer.read(absolutePath(join(dataRoot, 'memory', 'not-a-uuid', 'learnings.md')))).toBeUndefined();
    expect(writer.read(absolutePath(join(outside, 'learnings.md')))).toBeUndefined();
  });

  it('is idempotent: a second run over the same (now-renamed) tree only skips and stays marked at the current version', async () => {
    const pid = freshId();
    const sid = freshId();
    await seedLegacyProject(dataRoot, pid, 'alpha');
    await seedLegacySprint(dataRoot, sid, 'beta');

    const first = await apply(absolutePath(dataRoot), await dryRun(absolutePath(dataRoot)), ctx());
    expect(first.kind).toBe('ok');

    const second = await apply(absolutePath(dataRoot), await dryRun(absolutePath(dataRoot)), ctx());
    expect(second.kind).toBe('ok');
    if (second.kind === 'ok') expect(second.applied.every((a) => a.status === 'skipped')).toBe(true);
    expect((await readDataVersion(absolutePath(dataRoot))).dataVersion).toBe(2);
  });
});
