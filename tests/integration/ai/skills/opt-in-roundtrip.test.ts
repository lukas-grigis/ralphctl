/**
 * Cross-module opt-in-skills roundtrip — the ONE gap none of the per-module suites cover: the
 * full lifecycle a real launch actually exercises, driven end-to-end through the REAL catalog
 * (`createSkillCatalog`), the REAL phase source (`createPhaseSkillSource`, via the launcher), and
 * the REAL resolution seam (`buildComposedSkillSource` / `createResolvedSkillSource`).
 *
 * Per-module edge cases already live in `phase/catalog.test.ts` (enable/disable/update status
 * transitions), `phase/source.test.ts` (phase-folder enumeration), `phase/provenance.test.ts`
 * (hash/status derivation), and `launcher-composition.test.ts` (dedupe + opt-out resolution
 * against empty phase folders). This file does NOT re-derive those — it proves the seam between
 * them: a catalog `enable()` call is actually visible to a launch's resolved skill set, a
 * catalog-managed copy actually shadows a bundled default, `disable()` actually removes it from
 * resolution, `updateAll()` actually distinguishes a stale copy from a locally-modified one, and
 * the settings/override opt-out still applies to a skill that came from the phase folder rather
 * than the bundled source.
 *
 * `createSkillCatalog` reads `BUNDLED_SKILLS` directly from the registry (not as an injected
 * dep), so this suite uses the REAL registry entries + the REAL bundled root
 * (`createBundledSkillRawReader()`) rather than fake skill names — the catalog's `list()` /
 * `updateAll()` iterate the actual table, so a fake reader would only cover `enable`/`update`
 * while leaving `list`/`updateAll` reading real (mismatched) content.
 */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { passthroughRunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';
import { buildComposedSkillSource } from '@src/application/ui/shared/launcher.ts';
import type { LauncherDeps } from '@src/application/ui/shared/launcher.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { createBundledSkillRawReader, createBundledSkillSource } from '@src/integration/ai/skills/bundled/source.ts';
import { BUNDLED_SKILLS } from '@src/integration/ai/skills/_engine/registry.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import { createSkillCatalog } from '@src/integration/ai/skills/phase/catalog.ts';
import { PHASE_FLOW_DIR } from '@src/integration/ai/skills/phase/source.ts';
import {
  createProvenanceStore,
  hashSkillContent,
  PROVENANCE_FILENAME,
} from '@src/integration/ai/skills/phase/provenance.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

const noopLogger = {
  named: () => noopLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const PROJECT_ID = 'project-fixture-id' as unknown as ProjectId;

/** Repo-less project ⇒ the project skill source contributes nothing to this suite. */
const project = {
  id: PROJECT_ID,
  slug: 'fixture-project',
  displayName: 'Fixture Project',
  repositories: [],
} as unknown as Project;

const snapshot = { project } as unknown as AppStateSnapshot;

const makeDeps = (root: string): LauncherDeps => {
  const storage = { operatorSkillsRoot: abs(root) } as unknown as StoragePaths;
  const app = { logger: noopLogger, skillSource: createBundledSkillSource() } as unknown as AppDeps;
  return { app, storage, interactive: {} as LauncherDeps['interactive'], runInTerminal: passthroughRunInTerminal };
};

const makeCatalogRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), 'skills-roundtrip-'));

const makeCatalog = (root: string) =>
  createSkillCatalog({
    operatorSkillsRoot: abs(root),
    writeFile: createAtomicWriteFile(),
    bundledRawReader: createBundledSkillRawReader(),
    logger: noopLogger,
  });

const forFlow = async (
  source: SkillSource,
  flow: Parameters<SkillSource['getForFlow']>[0]
): Promise<readonly Skill[]> => {
  const r = await source.getForFlow(flow);
  if (!r.ok) throw new Error(`getForFlow failed: ${r.error.message}`);
  return r.value;
};

const withSkills = (disabled: NonNullable<Settings['ai']['skills']>): Settings => ({
  ...DEFAULT_SETTINGS,
  ai: { ...DEFAULT_SETTINGS.ai, skills: disabled },
});

describe('opt-in skills — cross-module roundtrip', () => {
  it('enable() via the catalog resolves through the launcher, shadows a bundled default, and disable() reverses both', async () => {
    const root = await makeCatalogRoot();
    const deps = makeDeps(root);
    const catalog = makeCatalog(root);

    // A skill NOT default-on for 'plan' — proves opt-in ADDS a skill the flow wouldn't otherwise load.
    const optInSkill = BUNDLED_SKILLS.find((e) => !e.defaultFor.includes('plan'));
    // A skill that IS default-on for 'plan' — proves a phase-folder copy SHADOWS the bundled default.
    const shadowSkill = BUNDLED_SKILLS.find((e) => e.defaultFor.includes('plan'));
    if (optInSkill === undefined || shadowSkill === undefined) {
      throw new Error('registry fixture requires both a non-default and a default-for-plan entry');
    }

    // Baseline: before any enable, the opt-in skill is absent and the shadow skill loads unmodified.
    const baseline = await forFlow(
      buildComposedSkillSource(deps, snapshot, 'claude-code', 'plan', DEFAULT_SETTINGS, {}),
      'plan'
    );
    expect(baseline.map((s) => s.name)).not.toContain(optInSkill.name);
    expect(baseline.map((s) => s.name)).toContain(shadowSkill.name);

    // (b) enable(name, [flow]) via the catalog — phase folder now holds SKILL.md + provenance.
    const enabledOptIn = await catalog.enable(optInSkill.name, ['plan']);
    expect(enabledOptIn.ok).toBe(true);
    const optInDir = join(root, PHASE_FLOW_DIR.plan, optInSkill.name);
    const optInSkillMd = await readFile(join(optInDir, 'SKILL.md'), 'utf-8');
    expect(optInSkillMd.length).toBeGreaterThan(0);
    const optInProvenance = JSON.parse(await readFile(join(optInDir, PROVENANCE_FILENAME), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(optInProvenance.source).toBe('bundled');
    expect(optInProvenance.skill).toBe(optInSkill.name);

    // (c) resolve via the launcher path — the enabled skill now appears for that flow.
    const afterEnable = await forFlow(
      buildComposedSkillSource(deps, snapshot, 'claude-code', 'plan', DEFAULT_SETTINGS, {}),
      'plan'
    );
    expect(afterEnable.map((s) => s.name)).toContain(optInSkill.name);

    // Shadowing: enable the ALREADY-default skill too, then hand-edit its phase copy. Composition
    // order (bundled → project → operator → phase, phase LAST) means the resolved decorator's
    // last-wins dedupe must surface the phase-folder content, not the bundled original.
    expect((await catalog.enable(shadowSkill.name, ['plan'])).ok).toBe(true);
    const shadowDir = join(root, PHASE_FLOW_DIR.plan, shadowSkill.name);
    const shadowedDescription = `CUSTOMIZED shadow copy for ${shadowSkill.name}`;
    const editedRaw = `---\nname: ${shadowSkill.name}\ndescription: ${shadowedDescription}\n---\n\ncustom body\n`;
    await writeFile(join(shadowDir, 'SKILL.md'), editedRaw, 'utf-8');

    const afterShadow = await forFlow(
      buildComposedSkillSource(deps, snapshot, 'claude-code', 'plan', DEFAULT_SETTINGS, {}),
      'plan'
    );
    const shadowMatches = afterShadow.filter((s) => s.name === shadowSkill.name);
    expect(shadowMatches).toHaveLength(1); // deduped, not doubled
    expect(shadowMatches[0]?.description).toBe(shadowedDescription);

    // (d) disable — both the opt-in addition and the shadowing copy disappear from resolution.
    expect((await catalog.disable(optInSkill.name, ['plan'])).ok).toBe(true);
    expect((await catalog.disable(shadowSkill.name, ['plan'])).ok).toBe(true);

    const afterDisable = await forFlow(
      buildComposedSkillSource(deps, snapshot, 'claude-code', 'plan', DEFAULT_SETTINGS, {}),
      'plan'
    );
    expect(afterDisable.map((s) => s.name)).not.toContain(optInSkill.name);
    const revertedShadow = afterDisable.find((s) => s.name === shadowSkill.name);
    const bundledShadowSkill = (await forFlow(createBundledSkillSource(), 'plan')).find(
      (s) => s.name === shadowSkill.name
    );
    // Reverts to the bundled default's own description once the shadowing copy is removed.
    expect(revertedShadow?.description).toBe(bundledShadowSkill?.description);
  });

  it('updateAll() updates an untampered stale copy but skips a locally-modified one', async () => {
    const root = await makeCatalogRoot();
    const catalog = makeCatalog(root);
    const rawReader = createBundledSkillRawReader();

    const [staleSkill, editedSkill] = BUNDLED_SKILLS;
    if (staleSkill === undefined || editedSkill === undefined || staleSkill.name === editedSkill.name) {
      throw new Error('registry fixture requires two distinct BUNDLED_SKILLS entries');
    }

    // "Untampered stale copy": the folder matches ITS OWN stamp (not locally-modified) but the
    // stamp is behind the real current bundled content (update-available).
    const staleDir = join(root, PHASE_FLOW_DIR.implement, staleSkill.name);
    await mkdir(staleDir, { recursive: true });
    const oldRaw = `---\nname: ${staleSkill.name}\ndescription: an older ${staleSkill.name} snapshot\n---\n\nold body\n`;
    await writeFile(join(staleDir, 'SKILL.md'), oldRaw, 'utf-8');
    const provenanceStore = createProvenanceStore({ writeFile: createAtomicWriteFile() });
    const staleStamped = await provenanceStore.writeProvenance(abs(staleDir), {
      source: 'bundled',
      skill: staleSkill.name,
      contentHash: hashSkillContent(oldRaw),
      ralphctlVersion: 'v0.0.0-test',
      copiedAt: new Date(0).toISOString(),
    });
    expect(staleStamped.ok).toBe(true);

    // "Locally-modified" copy: a real enable(), then a hand-edit that leaves the stamp untouched.
    expect((await catalog.enable(editedSkill.name, ['implement'])).ok).toBe(true);
    const editedDir = join(root, PHASE_FLOW_DIR.implement, editedSkill.name);
    const tamperedRaw = `---\nname: ${editedSkill.name}\ndescription: tampered ${editedSkill.name}\n---\n\ntampered body\n`;
    await writeFile(join(editedDir, 'SKILL.md'), tamperedRaw, 'utf-8');

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.find((e) => e.name === staleSkill.name)?.installs).toEqual([
      { flow: 'implement', status: 'update-available' },
    ]);
    expect(listed.value.find((e) => e.name === editedSkill.name)?.installs).toEqual([
      { flow: 'implement', status: 'locally-modified' },
    ]);

    const result = await catalog.updateAll();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.updated).toContain(staleSkill.name);
    expect(result.value.updated).not.toContain(editedSkill.name);

    const staleAfter = await readFile(join(staleDir, 'SKILL.md'), 'utf-8');
    const realStaleRaw = await rawReader.readRaw(staleSkill.name);
    expect(realStaleRaw.ok).toBe(true);
    if (realStaleRaw.ok) expect(staleAfter).toBe(realStaleRaw.value);

    const editedAfter = await readFile(join(editedDir, 'SKILL.md'), 'utf-8');
    expect(editedAfter).toBe(tamperedRaw); // untouched — an edit is never silently discarded
  });

  it('saved settings disabled-list and run-scoped override REPLACE semantics resolve through the composed source', async () => {
    const root = await makeCatalogRoot();
    const deps = makeDeps(root);
    const catalog = makeCatalog(root);

    const optInSkill = BUNDLED_SKILLS.find((e) => !e.defaultFor.includes('plan'));
    if (optInSkill === undefined) throw new Error('registry fixture requires a non-default-for-plan entry');
    expect((await catalog.enable(optInSkill.name, ['plan'])).ok).toBe(true);

    const settings = withSkills({ plan: { disabled: [optInSkill.name] } });

    // Saved disabled-list subtracts even a skill that came from the phase folder, not just bundled.
    const savedNames = (
      await forFlow(buildComposedSkillSource(deps, snapshot, 'claude-code', 'plan', settings, {}), 'plan')
    ).map((s) => s.name);
    expect(savedNames).not.toContain(optInSkill.name);

    // A run override REPLACES the saved row outright — an empty override re-enables it for this run.
    const overrideNames = (
      await forFlow(
        buildComposedSkillSource(deps, snapshot, 'claude-code', 'plan', settings, {
          skillsOverride: { disabled: [] },
        }),
        'plan'
      )
    ).map((s) => s.name);
    expect(overrideNames).toContain(optInSkill.name);
  });
});
