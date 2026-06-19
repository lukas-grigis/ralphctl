/**
 * Integration tests for the migration dry-run scan (Wave 2). The dry-run computes the set of renames
 * a migration WOULD perform — and must touch NOTHING on disk (the user was burned by a past
 * migration; a read-only preview is the trust surface).
 *
 * Covers: legacy-only, mixed, already-migrated (empty plan), collision / malformed / missing-slug
 * flagged as problems, and a byte-identical disk after the scan.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { dryRun } from '@src/integration/persistence/data-migration/dry-run.ts';
import {
  freshId,
  seedLegacyMemory,
  seedLegacyProject,
  seedLegacySprint,
  seedNewProject,
  seedNewSprint,
  snapshotContents,
} from '@tests/integration/persistence/data-migration/_seed.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ralph-dryrun-'));
  await fs.mkdir(join(root, 'projects'), { recursive: true });
  await fs.mkdir(join(root, 'sprints'), { recursive: true });
  await fs.mkdir(join(root, 'memory'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const dataRoot = () => absolutePath(root);

describe('dryRun', () => {
  it('plans renames for legacy-only entries across all three families', async () => {
    const pid = freshId();
    const sid = freshId();
    await seedLegacyProject(root, pid, 'alpha');
    await seedLegacySprint(root, sid, 'beta');
    await seedLegacyMemory(root, pid);

    const report = await dryRun(dataRoot());

    expect(report.problems).toEqual([]);
    const byKind = Object.fromEntries(report.planned.map((p) => [p.kind, p]));
    expect(byKind.project?.toName).toBe(`${pid}--alpha.json`);
    expect(byKind.sprint?.toName).toBe(`${sid}--beta`);
    // The memory dir's slug comes from the OWNING project's JSON.
    expect(byKind.memory?.toName).toBe(`${pid}--alpha`);
  });

  it('already-migrated tree → empty plan (idempotent)', async () => {
    await seedNewProject(root, freshId(), 'alpha');
    await seedNewSprint(root, freshId(), 'beta');

    const report = await dryRun(dataRoot());
    expect(report.planned).toEqual([]);
    expect(report.problems).toEqual([]);
  });

  it('mixed tree → only the legacy entries are planned', async () => {
    const legacy = freshId();
    await seedLegacySprint(root, legacy, 'legacy-sprint');
    await seedNewSprint(root, freshId(), 'already-new');

    const report = await dryRun(dataRoot());
    expect(report.planned).toHaveLength(1);
    expect(report.planned[0]?.id).toBe(legacy);
  });

  it('flags a collision: target <id>--<slug> already exists', async () => {
    const id = freshId();
    // Legacy bare dir AND a slugged dir for the same id (a crash-left pair).
    await seedLegacySprint(root, id, 'beta');
    await seedNewSprint(root, id, 'beta');

    const report = await dryRun(dataRoot());
    expect(report.planned).toEqual([]);
    expect(report.problems.some((p) => p.reason.includes('collision'))).toBe(true);
  });

  it('flags a malformed (non-uuid) directory name', async () => {
    await fs.mkdir(join(root, 'sprints', 'not-a-uuid'), { recursive: true });
    await fs.writeFile(join(root, 'sprints', 'not-a-uuid', 'sprint.json'), '{}', 'utf8');

    const report = await dryRun(dataRoot());
    expect(report.planned).toEqual([]);
    expect(report.problems.some((p) => p.name === 'not-a-uuid' && p.reason.includes('uuidv7'))).toBe(true);
  });

  it('flags a missing / unreadable slug', async () => {
    const id = freshId();
    const dir = join(root, 'sprints', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'sprint.json'), JSON.stringify({ id }), 'utf8'); // no slug

    const report = await dryRun(dataRoot());
    expect(report.planned).toEqual([]);
    expect(report.problems.some((p) => p.name === id && p.reason.includes('slug'))).toBe(true);
  });

  it('touches NOTHING on disk — the tree is byte-identical after a dry-run', async () => {
    const pid = freshId();
    await seedLegacyProject(root, pid, 'alpha');
    await seedLegacySprint(root, freshId(), 'beta');
    await seedLegacyMemory(root, pid, '{"x":1}\n');

    const before = await snapshotContents(root);
    await dryRun(dataRoot());
    const after = await snapshotContents(root);
    expect(after).toEqual(before);
  });
});
