import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';
import { BUNDLED_SKILLS } from '@src/integration/ai/skills/_engine/registry.ts';
import type { BundledSkillRawReader } from '@src/integration/ai/skills/_engine/bundled-skill-raw-reader.ts';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import { PHASE_FLOW_DIR } from '@src/integration/ai/skills/phase/source.ts';
import { PROVENANCE_FILENAME } from '@src/integration/ai/skills/phase/provenance.ts';
import { createSkillCatalog } from '@src/integration/ai/skills/phase/catalog.ts';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

const recordingLogger = () => {
  const bus = createInMemoryEventBus();
  return createEventBusLogger({ eventBus: bus, clock: IsoTimestamp.now });
};

/** Deterministic, always-valid synthetic SKILL.md content for `name` at revision `seed`. */
const fakeBundledContent = (name: string, seed = 0): string =>
  `---\nname: ${name}\ndescription: ${name} bundled description v${String(seed)}\n---\n\n# ${name}\nbody v${String(seed)}\n`;

/**
 * Fake {@link BundledSkillRawReader} that resolves ANY name to valid synthetic content by
 * default — so `list()` / `updateAll()` (which iterate the REAL `BUNDLED_SKILLS` table) never
 * fail against a registry this test suite doesn't control the exact membership of. Individual
 * tests mutate `overrides` to simulate "the bundle moved on", or add to `errorFor` to exercise
 * the read-failure propagation path.
 */
const createFakeRawReader = (overrides: Map<string, string>, errorFor: Set<string>): BundledSkillRawReader => ({
  async readRaw(name: string) {
    if (errorFor.has(name)) {
      return Result.error(new StorageError({ subCode: 'io', message: `boom: ${name}`, path: name }));
    }
    return Result.ok(overrides.get(name) ?? fakeBundledContent(name));
  },
});

const findEntry = (entries: readonly SkillCatalogEntry[], name: string): SkillCatalogEntry | undefined =>
  entries.find((e) => e.name === name);

describe('createSkillCatalog', () => {
  it('list() returns one entry per BUNDLED_SKILLS name with registry defaults and no installs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(new Map(), new Set()),
      logger: recordingLogger(),
    });

    const result = await catalog.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(BUNDLED_SKILLS.length);
    for (const registryEntry of BUNDLED_SKILLS) {
      const entry = findEntry(result.value, registryEntry.name);
      expect(entry).toBeDefined();
      expect(entry?.defaultFor).toEqual(registryEntry.defaultFor);
      expect(entry?.recommendedFor).toEqual(registryEntry.recommendedFor);
      expect(entry?.installs).toEqual([]);
      expect(entry?.description).toBe(`${registryEntry.name} bundled description v0`);
    }
  });

  it('enable() copies the bundled skill verbatim and stamps provenance; list() reports in-sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const name = BUNDLED_SKILLS[0]!.name;
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(new Map(), new Set()),
      logger: recordingLogger(),
    });

    const enabled = await catalog.enable(name, ['plan']);
    expect(enabled.ok).toBe(true);

    const dir = join(root, PHASE_FLOW_DIR.plan, name);
    const onDisk = await readFile(join(dir, 'SKILL.md'), 'utf-8');
    expect(onDisk).toBe(fakeBundledContent(name));

    const stamp = JSON.parse(await readFile(join(dir, PROVENANCE_FILENAME), 'utf-8')) as Record<string, unknown>;
    expect(stamp.source).toBe('bundled');
    expect(stamp.skill).toBe(name);
    expect(stamp.ralphctlVersion).toBe(CLI_METADATA.currentVersion);

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const entry = findEntry(listed.value, name);
    expect(entry?.installs).toEqual([{ flow: 'plan', status: 'in-sync' }]);
  });

  it('enable() is idempotent for an in-sync install (re-copies identical bytes)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const name = BUNDLED_SKILLS[0]!.name;
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(new Map(), new Set()),
      logger: recordingLogger(),
    });

    expect((await catalog.enable(name, ['implement'])).ok).toBe(true);
    expect((await catalog.enable(name, ['implement'])).ok).toBe(true);

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(findEntry(listed.value, name)?.installs).toEqual([{ flow: 'implement', status: 'in-sync' }]);
  });

  it('enable() never overwrites a locally-modified copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const name = BUNDLED_SKILLS[0]!.name;
    const overrides = new Map<string, string>();
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(overrides, new Set()),
      logger: recordingLogger(),
    });

    expect((await catalog.enable(name, ['readiness'])).ok).toBe(true);
    const dir = join(root, PHASE_FLOW_DIR.readiness, name);
    const editedContent = `${fakeBundledContent(name)}operator edit\n`;
    await writeFile(join(dir, 'SKILL.md'), editedContent, 'utf-8');

    // Bundle also moves on — enable must still leave the edited copy alone.
    overrides.set(name, fakeBundledContent(name, 1));
    expect((await catalog.enable(name, ['readiness'])).ok).toBe(true);

    const onDisk = await readFile(join(dir, 'SKILL.md'), 'utf-8');
    expect(onDisk).toBe(editedContent);

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(findEntry(listed.value, name)?.installs).toEqual([{ flow: 'readiness', status: 'locally-modified' }]);
  });

  it('list() reports update-available when the bundle moves on after an in-sync enable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const name = BUNDLED_SKILLS[0]!.name;
    const overrides = new Map<string, string>();
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(overrides, new Set()),
      logger: recordingLogger(),
    });

    expect((await catalog.enable(name, ['ideate'])).ok).toBe(true);
    overrides.set(name, fakeBundledContent(name, 1));

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(findEntry(listed.value, name)?.installs).toEqual([{ flow: 'ideate', status: 'update-available' }]);
  });

  it('disable() removes the folder + sidecar; a missing folder is a no-op', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const name = BUNDLED_SKILLS[0]!.name;
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(new Map(), new Set()),
      logger: recordingLogger(),
    });

    expect((await catalog.enable(name, ['refine'])).ok).toBe(true);
    const disabled = await catalog.disable(name, ['refine']);
    expect(disabled.ok).toBe(true);

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(findEntry(listed.value, name)?.installs).toEqual([]);

    // Disabling an already-absent flow is a documented no-op, not an error.
    const again = await catalog.disable(name, ['refine']);
    expect(again.ok).toBe(true);
  });

  it('update() overwrites a locally-modified copy and re-stamps to the current bundled content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const name = BUNDLED_SKILLS[0]!.name;
    const overrides = new Map<string, string>();
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(overrides, new Set()),
      logger: recordingLogger(),
    });

    expect((await catalog.enable(name, ['plan'])).ok).toBe(true);
    const dir = join(root, PHASE_FLOW_DIR.plan, name);
    await writeFile(join(dir, 'SKILL.md'), `${fakeBundledContent(name)}operator edit\n`, 'utf-8');
    overrides.set(name, fakeBundledContent(name, 2));

    const updated = await catalog.update(name, ['plan']);
    expect(updated.ok).toBe(true);

    const onDisk = await readFile(join(dir, 'SKILL.md'), 'utf-8');
    expect(onDisk).toBe(fakeBundledContent(name, 2));

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(findEntry(listed.value, name)?.installs).toEqual([{ flow: 'plan', status: 'in-sync' }]);
  });

  it('updateAll() updates only update-available installs, skips locally-modified and manual, returns updated names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const [staleSkill, editedSkill] = BUNDLED_SKILLS;
    if (staleSkill === undefined || editedSkill === undefined || staleSkill.name === editedSkill.name) {
      throw new Error('test requires at least two distinct BUNDLED_SKILLS entries');
    }
    const overrides = new Map<string, string>();
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(overrides, new Set()),
      logger: recordingLogger(),
    });

    // A hand-dropped folder with no bundled counterpart in scope — always 'manual', never touched.
    const manualDir = join(root, PHASE_FLOW_DIR.implement, 'hand-authored-thing');
    await mkdir(manualDir, { recursive: true });
    await writeFile(
      join(manualDir, 'SKILL.md'),
      '---\nname: hand-authored-thing\ndescription: dropped in by hand\n---\n\nbody\n',
      'utf-8'
    );

    expect((await catalog.enable(staleSkill.name, ['implement'])).ok).toBe(true);
    expect((await catalog.enable(editedSkill.name, ['implement'])).ok).toBe(true);
    // staleSkill's bundle moves on (safe to auto-update); editedSkill's copy is hand-edited
    // (must survive updateAll untouched).
    overrides.set(staleSkill.name, fakeBundledContent(staleSkill.name, 1));
    const editedContent = `${fakeBundledContent(editedSkill.name)}operator edit\n`;
    await writeFile(join(root, PHASE_FLOW_DIR.implement, editedSkill.name, 'SKILL.md'), editedContent, 'utf-8');

    const result = await catalog.updateAll();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.updated).toEqual([staleSkill.name]);

    const staleOnDisk = await readFile(join(root, PHASE_FLOW_DIR.implement, staleSkill.name, 'SKILL.md'), 'utf-8');
    expect(staleOnDisk).toBe(fakeBundledContent(staleSkill.name, 1));
    const editedOnDisk = await readFile(join(root, PHASE_FLOW_DIR.implement, editedSkill.name, 'SKILL.md'), 'utf-8');
    expect(editedOnDisk).toBe(editedContent); // untouched

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const manualEntry = findEntry(listed.value, 'hand-authored-thing');
    expect(manualEntry).toEqual({
      name: 'hand-authored-thing',
      description: 'dropped in by hand',
      defaultFor: [],
      recommendedFor: [],
      installs: [{ flow: 'implement', status: 'manual' }],
    });
  });

  it('disable() also removes a manual (non-bundled) phase-folder entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const manualDir = join(root, PHASE_FLOW_DIR.refine, 'hand-authored-thing');
    await mkdir(manualDir, { recursive: true });
    await writeFile(
      join(manualDir, 'SKILL.md'),
      '---\nname: hand-authored-thing\ndescription: dropped in by hand\n---\n\nbody\n',
      'utf-8'
    );
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(new Map(), new Set()),
      logger: recordingLogger(),
    });

    const disabled = await catalog.disable('hand-authored-thing', ['refine']);
    expect(disabled.ok).toBe(true);

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(findEntry(listed.value, 'hand-authored-thing')).toBeUndefined();
  });

  it('propagates a bundled-read failure from enable() and update()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(new Map(), new Set(['missing-bundle'])),
      logger: recordingLogger(),
    });

    const enabled = await catalog.enable('missing-bundle', ['plan']);
    expect(enabled.ok).toBe(false);
    const updated = await catalog.update('missing-bundle', ['plan']);
    expect(updated.ok).toBe(false);
  });

  it('enable() reports per-flow outcomes: copies fresh flows, skips edit-protected ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const name = BUNDLED_SKILLS[0]!.name;
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(new Map(), new Set()),
      logger: recordingLogger(),
    });
    // First enable: both flows fresh → both copied.
    const first = await catalog.enable(name, ['plan', 'implement']);
    expect(first.ok && first.value).toEqual({ copied: ['plan', 'implement'], skipped: [] });
    // Hand-edit the plan copy → edit-protected; re-enable must skip it and re-copy implement.
    const planDir = join(root, PHASE_FLOW_DIR.plan, name);
    await writeFile(join(planDir, 'SKILL.md'), 'edited by the operator', 'utf-8');
    const second = await catalog.enable(name, ['plan', 'implement']);
    expect(second.ok && second.value).toEqual({ copied: ['implement'], skipped: ['plan'] });
    expect(await readFile(join(planDir, 'SKILL.md'), 'utf-8')).toBe('edited by the operator');
  });

  it('enable() repairs a stranded pristine copy whose stamp write was interrupted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const name = BUNDLED_SKILLS[0]!.name;
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(new Map(), new Set()),
      logger: recordingLogger(),
    });
    // Simulate an interrupted enable: SKILL.md written verbatim, sidecar missing.
    const dir = join(root, PHASE_FLOW_DIR.plan, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), fakeBundledContent(name), 'utf-8');
    const repaired = await catalog.enable(name, ['plan']);
    expect(repaired.ok && repaired.value).toEqual({ copied: ['plan'], skipped: [] });
    // The sidecar now exists and the install reads in-sync, not manual.
    const stamped = await readFile(join(dir, PROVENANCE_FILENAME), 'utf-8');
    expect(stamped).toContain(name);
    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(findEntry(listed.value, name)?.installs).toEqual([{ flow: 'plan', status: 'in-sync' }]);
  });

  it('list() surfaces a folder without SKILL.md as broken, and disable() removes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
    const name = BUNDLED_SKILLS[0]!.name;
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: createFakeRawReader(new Map(), new Set()),
      logger: recordingLogger(),
    });
    const dir = join(root, PHASE_FLOW_DIR.ideate, name);
    await mkdir(dir, { recursive: true });
    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(findEntry(listed.value, name)?.installs).toEqual([{ flow: 'ideate', status: 'broken' }]);

    const removed = await catalog.disable(name, ['ideate']);
    expect(removed.ok).toBe(true);
    const after = await catalog.list();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(findEntry(after.value, name)?.installs).toEqual([]);
  });
});
