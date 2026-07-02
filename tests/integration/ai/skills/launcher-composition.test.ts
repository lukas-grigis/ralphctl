/**
 * Launcher-level skill-composition cover for `buildComposedSkillSource`
 * (`src/application/ui/shared/launcher.ts`) — the ONE skill-selection resolution point — plus
 * `buildSkillCandidates` / `flowMountsSkills`, the customize picker's skills-step data source.
 *
 * These tests drive the REAL launcher helpers (not a reconstruction, which could drift) against
 * the REAL bundled skill source, an empty operator/phase root (a fresh tmpdir), and a repo-less
 * project so the project source is empty too. They fence:
 *
 *   1. Zero-config invariant — no `settings.ai.skills`, no `skillsOverride`, empty phase folders ⇒
 *      the resolved set is byte-for-byte identical (names + order + content) to today's bundled set.
 *   2. Opt-out subtraction — a saved `settings.ai.skills[flow].disabled` and a per-run
 *      `skillsOverride.disabled` both drop the named skill from the resolved set.
 *   3. Run-replaces-saved semantics — when `extras.skillsOverride` is present it REPLACES the
 *      saved row outright rather than unioning with it, so a per-run RE-ENABLE of a
 *      remembered-off skill is possible.
 *   4. Aliased-flow inheritance — a `review` launch reads `implement`'s disabled row via the shared
 *      `aiFlowIdFor` mapping (one aliasing rule everywhere).
 *   5. `buildSkillCandidates` — the pre-subtraction, origin-tagged candidate list the customize
 *      picker's skills step seeds from, and `flowMountsSkills` — the gate deciding which flows get
 *      the step at all.
 *
 * The runner is never started; the helpers are pure factories, so a minimal `LauncherDeps` suffices.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildComposedSkillSource,
  buildSkillCandidates,
  bundledDefaultSkillNames,
  flowMountsSkills,
} from '@src/application/ui/shared/launcher.ts';
import type { LauncherDeps } from '@src/application/ui/shared/launcher.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { passthroughRunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';
import { createBundledSkillSource } from '@src/integration/ai/skills/bundled/source.ts';
import { skillsForFlow } from '@src/integration/ai/skills/_engine/registry.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';

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

/** Repo-less project ⇒ the project skill source contributes nothing. */
const project = {
  id: PROJECT_ID,
  slug: 'fixture-project',
  displayName: 'Fixture Project',
  repositories: [],
} as unknown as Project;

const snapshot = { project } as unknown as AppStateSnapshot;

/** `operatorSkillsRoot` points at a fresh empty dir ⇒ operator + phase sources are both empty. */
const makeDeps = async (): Promise<LauncherDeps> => {
  const emptyRoot = await mkdtemp(join(tmpdir(), 'launcher-skills-'));
  const storage = {
    operatorSkillsRoot: abs(emptyRoot),
  } as unknown as StoragePaths;
  const app = {
    logger: noopLogger,
    skillSource: createBundledSkillSource(),
  } as unknown as AppDeps;
  return { app, storage, interactive: {} as LauncherDeps['interactive'], runInTerminal: passthroughRunInTerminal };
};

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

describe('buildComposedSkillSource — zero-config invariant', () => {
  it('produces a byte-for-byte identical skill set + order to the bundled-only source today', async () => {
    const deps = await makeDeps();
    const resolved = buildComposedSkillSource(deps, snapshot, 'claude-code', 'implement', DEFAULT_SETTINGS, {});

    // Baseline = today's effective set: bundled-only (project + operator + phase are all empty).
    const baseline = await forFlow(createBundledSkillSource(), 'implement');
    const actual = await forFlow(resolved, 'implement');

    expect(actual).toEqual(baseline);
    expect(actual.length).toBeGreaterThan(0); // guards against an accidental empty-vs-empty pass
  });
});

describe('buildComposedSkillSource — opt-out subtraction', () => {
  it('drops a skill named in the saved settings.ai.skills[flow].disabled row', async () => {
    const deps = await makeDeps();
    const settings = withSkills({ implement: { disabled: ['ralphctl-alignment'] } });
    const resolved = buildComposedSkillSource(deps, snapshot, 'claude-code', 'implement', settings, {});

    const names = (await forFlow(resolved, 'implement')).map((s) => s.name);
    expect(names).not.toContain('ralphctl-alignment');
    // Everything else the flow loads by default is untouched.
    const baseline = (await forFlow(createBundledSkillSource(), 'implement')).map((s) => s.name);
    expect(names).toEqual(baseline.filter((n) => n !== 'ralphctl-alignment'));
  });

  it('drops a skill named in the per-run skillsOverride.disabled (no saved row)', async () => {
    const deps = await makeDeps();
    const resolved = buildComposedSkillSource(deps, snapshot, 'claude-code', 'implement', DEFAULT_SETTINGS, {
      skillsOverride: { disabled: ['ralphctl-iterative-review'] },
    });

    const names = (await forFlow(resolved, 'implement')).map((s) => s.name);
    expect(names).not.toContain('ralphctl-iterative-review');
  });

  it('a per-run override REPLACES the saved row — it does not union with it', async () => {
    // Run-replaces-saved semantics (not union): the saved row disables `ralphctl-alignment`, but
    // this run's override only names `ralphctl-iterative-review`, so alignment is NOT subtracted
    // for this launch — the override wins outright.
    const deps = await makeDeps();
    const settings = withSkills({ implement: { disabled: ['ralphctl-alignment'] } });
    const resolved = buildComposedSkillSource(deps, snapshot, 'claude-code', 'implement', settings, {
      skillsOverride: { disabled: ['ralphctl-iterative-review'] },
    });

    const names = (await forFlow(resolved, 'implement')).map((s) => s.name);
    expect(names).toContain('ralphctl-alignment');
    expect(names).not.toContain('ralphctl-iterative-review');
  });

  it('an empty per-run override RE-ENABLES every saved-disabled skill for the run', async () => {
    // The mechanism a per-run "re-enable a remembered-off skill" relies on: picking nothing to
    // disable this run means `skillsOverride: { disabled: [] }`, which still REPLACES the saved
    // row (an empty array is a defined override, not an absent one).
    const deps = await makeDeps();
    const settings = withSkills({ implement: { disabled: ['ralphctl-alignment'] } });
    const resolved = buildComposedSkillSource(deps, snapshot, 'claude-code', 'implement', settings, {
      skillsOverride: { disabled: [] },
    });

    const names = (await forFlow(resolved, 'implement')).map((s) => s.name);
    expect(names).toContain('ralphctl-alignment');
    const baseline = (await forFlow(createBundledSkillSource(), 'implement')).map((s) => s.name);
    expect(names).toEqual(baseline);
  });
});

describe('buildComposedSkillSource — aliased-flow row inheritance', () => {
  it('a review launch reads implement’s saved disabled row (aiFlowIdFor: review → implement)', async () => {
    const deps = await makeDeps();
    // The opt-out is stored under implement; a review dispatch must honour it.
    const settings = withSkills({ implement: { disabled: ['ralphctl-alignment'] } });
    const resolved = buildComposedSkillSource(deps, snapshot, 'claude-code', 'review', settings, {});

    // Review would enumerate implement's skills — getForFlow('implement') is the phase it resolves.
    const names = (await forFlow(resolved, 'implement')).map((s) => s.name);
    expect(names).not.toContain('ralphctl-alignment');
  });

  it('maps the create-pr orchestration id to the createPr settings row', async () => {
    const deps = await makeDeps();
    const settings = withSkills({ createPr: { disabled: ['ralphctl-code-review-and-quality'] } });
    const resolved = buildComposedSkillSource(deps, snapshot, 'claude-code', 'create-pr', settings, {});

    const names = (await forFlow(resolved, 'createPr')).map((s) => s.name);
    expect(names).not.toContain('ralphctl-code-review-and-quality');
  });
});

describe('flowMountsSkills — gate for the customize picker skills step', () => {
  it('returns true only for the five flows whose launch context threads ctx.skillSource', () => {
    for (const id of ['refine', 'plan', 'implement', 'readiness', 'ideate']) {
      expect(flowMountsSkills(id)).toBe(true);
    }
  });

  it('returns false for aliased / non-mounting flows and non-AI flows', () => {
    for (const id of ['review', 'detect-scripts', 'detect-skills', 'create-pr', 'create-sprint', 'close-sprint']) {
      expect(flowMountsSkills(id)).toBe(false);
    }
  });
});

describe('buildSkillCandidates — pre-subtraction, origin-tagged candidate list', () => {
  it('returns empty for a flow with no AI row and for one flowMountsSkills rejects', async () => {
    const deps = await makeDeps();
    const nonAi = await buildSkillCandidates(deps, snapshot, 'create-sprint', DEFAULT_SETTINGS);
    expect(nonAi).toEqual({ candidates: [], savedDisabled: [] });

    // `review` HAS an AI row (aliases implement) but its own launcher never mounts skillSource.
    const nonMounting = await buildSkillCandidates(deps, snapshot, 'review', DEFAULT_SETTINGS);
    expect(nonMounting).toEqual({ candidates: [], savedDisabled: [] });
  });

  it('lists every bundled-default skill for the flow, tagged with origin bundled-default', async () => {
    const deps = await makeDeps();
    const result = await buildSkillCandidates(deps, snapshot, 'implement', DEFAULT_SETTINGS);
    expect(result.settingsFlow).toBe('implement');
    const names = result.candidates.map((c) => c.name);
    expect(names).toEqual(skillsForFlow('implement').slice());
    for (const candidate of result.candidates) {
      expect(candidate.origin).toBe('bundled-default');
      expect(candidate.description.length).toBeGreaterThan(0);
    }
  });

  it('savedDisabled mirrors settings.ai.skills[flow].disabled — candidates are NOT pre-subtracted', async () => {
    const deps = await makeDeps();
    const settings = withSkills({ implement: { disabled: ['ralphctl-alignment'] } });
    const result = await buildSkillCandidates(deps, snapshot, 'implement', settings);
    expect(result.savedDisabled).toEqual(['ralphctl-alignment']);
    // Nothing is subtracted here — the disabled skill is still a candidate the picker can toggle.
    expect(result.candidates.map((c) => c.name)).toContain('ralphctl-alignment');
  });
});

describe('bundledDefaultSkillNames', () => {
  it('keeps only bundled-default-origin names, dropping project / operator / phase-folder names', async () => {
    const deps = await makeDeps();
    const { candidates } = await buildSkillCandidates(deps, snapshot, 'implement', DEFAULT_SETTINGS);
    const withExtra = [
      ...candidates,
      { name: 'ralphctl-fixture-repo-setup', description: 'setup', origin: 'project' as const },
      { name: 'ralphctl-operator-thing', description: 'operator', origin: 'operator' as const },
      { name: 'ralphctl-opted-in', description: 'opt-in', origin: 'phase-folder' as const },
    ];
    const bundledNames = bundledDefaultSkillNames(withExtra);
    expect(bundledNames.has('ralphctl-fixture-repo-setup')).toBe(false);
    expect(bundledNames.has('ralphctl-operator-thing')).toBe(false);
    expect(bundledNames.has('ralphctl-opted-in')).toBe(false);
    for (const c of candidates) expect(bundledNames.has(c.name)).toBe(true);
  });
});
