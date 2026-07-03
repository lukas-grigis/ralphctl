import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { AppEvent, LogEvent } from '@src/business/observability/events.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
// The operator source lives in a sibling directory; the SOURCE modules may not cross-import (ESLint
// sibling-isolation), but a TEST may. We import the real `OPERATOR_PROVIDER_DIR` here so the
// disjointness guard checks the ACTUAL operator constant, not a local copy, and reuse the operator's
// `RALPHCTL_SKILL_PREFIX` (the same namespace the phase source replicates) for the `ns` helper.
import { OPERATOR_PROVIDER_DIR, RALPHCTL_SKILL_PREFIX } from '@src/integration/ai/skills/operator/source.ts';
import { createPhaseSkillSource, PHASE_FLOW_DIR } from '@src/integration/ai/skills/phase/source.ts';

const ns = (name: string): string => `${RALPHCTL_SKILL_PREFIX}${name}`;

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

/** A logger backed by a real in-memory bus so tests assert genuine `LogEvent`s, not call spies. */
const recordingLogger = (): { logger: ReturnType<typeof createEventBusLogger>; logs: LogEvent[] } => {
  const bus = createInMemoryEventBus();
  const logs: LogEvent[] = [];
  bus.subscribe((e: AppEvent) => {
    if (e.type === 'log') logs.push(e);
  });
  return { logger: createEventBusLogger({ eventBus: bus, clock: IsoTimestamp.now }), logs };
};

const writeSkill = async (
  root: string,
  flowDir: string,
  name: string,
  opts: { frontmatterName?: string; description?: string } = {}
): Promise<void> => {
  const { frontmatterName = name, description = `${name} guidance` } = opts;
  const dir = join(root, flowDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${frontmatterName}\ndescription: ${description}\n---\n\n# ${name}\nbody\n`,
    'utf-8'
  );
};

describe('createPhaseSkillSource', () => {
  it('returns an empty list (no warning) when the flow directory is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase-source-'));
    const { logger, logs } = recordingLogger();

    const source = createPhaseSkillSource({ operatorSkillsRoot: abs(root), logger });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
    // A missing dir is the common no-config case — not even a warning.
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('reads <root>/<flowDir>/*/SKILL.md and returns parsed + prefixed skills for that flow only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase-source-'));
    await writeSkill(root, PHASE_FLOW_DIR.implement, 'impl-alpha');
    await writeSkill(root, PHASE_FLOW_DIR.implement, 'impl-beta');
    // A skill under a DIFFERENT flow dir must not leak into `implement`.
    await writeSkill(root, PHASE_FLOW_DIR.plan, 'plan-only');
    const { logger } = recordingLogger();

    const source = createPhaseSkillSource({ operatorSkillsRoot: abs(root), logger });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Install names carry the `ralphctl-` prefix so the adapter's exclude wildcard hides them.
    expect(result.value.map((s) => s.name).sort()).toEqual([ns('impl-alpha'), ns('impl-beta')]);
    const alpha = result.value.find((s) => s.name === ns('impl-alpha'));
    expect(alpha?.description).toBe('impl-alpha guidance');
    expect(alpha?.content).toContain('# impl-alpha');

    // The plan-only skill is reachable only through the plan directory.
    const plan = await source.getForFlow('plan');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.map((s) => s.name)).toEqual([ns('plan-only')]);
  });

  it('does not double-prefix a folder already named ralphctl-*', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase-source-'));
    await writeSkill(root, PHASE_FLOW_DIR.refine, 'ralphctl-prewired');
    const { logger } = recordingLogger();

    const source = createPhaseSkillSource({ operatorSkillsRoot: abs(root), logger });
    const result = await source.getForFlow('refine');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.name)).toEqual(['ralphctl-prewired']);
  });

  it('resolves the create-pr directory for the createPr flow id', async () => {
    expect(PHASE_FLOW_DIR.createPr).toBe('create-pr');
    const root = await mkdtemp(join(tmpdir(), 'phase-source-'));
    // Write under the kebab-case directory; the camelCase flow id must find it.
    await writeSkill(root, 'create-pr', 'pr-checklist');
    const { logger } = recordingLogger();

    const source = createPhaseSkillSource({ operatorSkillsRoot: abs(root), logger });
    const result = await source.getForFlow('createPr');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.name)).toEqual([ns('pr-checklist')]);
  });

  it('skips a malformed skill (frontmatter name mismatch) with a logged warning, keeping the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase-source-'));
    await writeSkill(root, PHASE_FLOW_DIR.implement, 'good-skill');
    // Folder name vs frontmatter name disagree → parse error → skipped.
    await writeSkill(root, PHASE_FLOW_DIR.implement, 'mismatch-folder', { frontmatterName: 'different-name' });
    const { logger, logs } = recordingLogger();

    const source = createPhaseSkillSource({ operatorSkillsRoot: abs(root), logger });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.name)).toEqual([ns('good-skill')]);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('invalid'))).toBe(true);
  });

  it('skips an unreadable individual skill with a logged warning, keeping the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase-source-'));
    const flowDir = PHASE_FLOW_DIR.implement;
    await writeSkill(root, flowDir, 'good-skill');
    // Make `<root>/<flowDir>/wedged/SKILL.md` a DIRECTORY → read fails with EISDIR, skip it.
    await mkdir(join(root, flowDir, 'wedged', 'SKILL.md'), { recursive: true });
    const { logger, logs } = recordingLogger();

    const source = createPhaseSkillSource({ operatorSkillsRoot: abs(root), logger });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.name)).toEqual([ns('good-skill')]);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('not readable'))).toBe(true);
  });

  it('emits a warn LogEvent for a contract-violating skill but still returns it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase-source-'));
    await writeSkill(root, PHASE_FLOW_DIR.implement, 'risky-skill');
    const { logger, logs } = recordingLogger();

    const violations: string[] = [];
    const warnIfContractViolated = (skill: Skill): void => {
      violations.push(skill.name);
      // A real guard logs through the same logger; emulate that so the LogEvent assertion holds.
      logger.named('skills.contract').warn('phase skill violates contract', { name: skill.name });
    };

    const source = createPhaseSkillSource({ operatorSkillsRoot: abs(root), logger, warnIfContractViolated });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Still installed — the operator owns their skills.
    expect(result.value.map((s) => s.name)).toEqual([ns('risky-skill')]);
    expect(violations).toEqual([ns('risky-skill')]);
    const warnLogs = logs.filter((l) => l.level === 'warn');
    expect(warnLogs.some((l) => l.message.includes('phase skill violates contract'))).toBe(true);
  });

  it('ignores non-SKILL.md sidecar files and dotfile entries in the flow directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase-source-'));
    const flowDir = PHASE_FLOW_DIR.implement;
    await writeSkill(root, flowDir, 'real-skill');
    // A provenance sidecar INSIDE the skill folder — a later task stamps this; it must never be
    // read as a skill (only `SKILL.md` is).
    await writeFile(join(root, flowDir, 'real-skill', '.provenance.json'), '{"source":"bundled"}', 'utf-8');
    // A stray file directly under the flow dir — not a directory, skipped.
    await writeFile(join(root, flowDir, 'notes.md'), 'scratch', 'utf-8');
    // A dotfile directory — skipped, and must NOT produce a "not readable" warning.
    await mkdir(join(root, flowDir, '.git'), { recursive: true });
    const { logger, logs } = recordingLogger();

    const source = createPhaseSkillSource({ operatorSkillsRoot: abs(root), logger });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.name)).toEqual([ns('real-skill')]);
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('getByName searches every flow directory and returns undefined for unknown names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase-source-'));
    await writeSkill(root, PHASE_FLOW_DIR.plan, 'in-plan');
    await writeSkill(root, PHASE_FLOW_DIR.readiness, 'in-readiness');
    const { logger } = recordingLogger();

    const source = createPhaseSkillSource({ operatorSkillsRoot: abs(root), logger });
    const fromPlan = await source.getByName(ns('in-plan'));
    expect(fromPlan.ok).toBe(true);
    if (!fromPlan.ok) return;
    expect(fromPlan.value?.name).toBe(ns('in-plan'));

    const fromReadiness = await source.getByName(ns('in-readiness'));
    expect(fromReadiness.ok).toBe(true);
    if (!fromReadiness.ok) return;
    expect(fromReadiness.value?.name).toBe(ns('in-readiness'));

    const miss = await source.getByName('nope');
    expect(miss.ok).toBe(true);
    if (!miss.ok) return;
    expect(miss.value).toBeUndefined();
  });

  it('getByName first match wins in the canonical FLOW_IDS order (refine before implement)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase-source-'));
    // Same folder name in two flow dirs; refine precedes implement in FLOW_IDS, so it wins.
    await writeSkill(root, PHASE_FLOW_DIR.refine, 'dup-skill', { description: 'from refine' });
    await writeSkill(root, PHASE_FLOW_DIR.implement, 'dup-skill', { description: 'from implement' });
    const { logger } = recordingLogger();

    const source = createPhaseSkillSource({ operatorSkillsRoot: abs(root), logger });
    const hit = await source.getByName(ns('dup-skill'));
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.value?.description).toBe('from refine');
  });

  it('phase flow-dir names are disjoint from operator provider-dir names (shared parent root)', () => {
    const flowDirs = new Set(Object.values(PHASE_FLOW_DIR));
    const providerDirs = Object.values(OPERATOR_PROVIDER_DIR);
    const overlap = providerDirs.filter((d) => flowDirs.has(d));
    expect(overlap).toEqual([]);
  });
});
