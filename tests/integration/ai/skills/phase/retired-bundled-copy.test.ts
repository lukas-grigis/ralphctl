import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { AppEvent, LogEvent } from '@src/business/observability/events.ts';
import { BUNDLED_SKILLS } from '@src/integration/ai/skills/_engine/registry.ts';
import { PROVENANCE_FILENAME } from '@src/integration/ai/skills/phase/provenance.ts';
import { createPhaseSkillSource, PHASE_FLOW_DIR } from '@src/integration/ai/skills/phase/source.ts';

// A catalog copy stamped from a bundled skill that has since been removed from BUNDLED_SKILLS must
// stop installing; an unstamped folder of the same name is the operator's own and still loads.

const RETIRED = 'ralphctl-cherny-workflow';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

const seed = async (dir: string, name: string, stampedAs?: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} guidance\n---\n\nbody\n`);
  if (stampedAs === undefined) return;
  const stamp = { source: 'bundled', skill: stampedAs, contentHash: 'x', ralphctlVersion: '0.29.0', copiedAt: 'now' };
  await writeFile(join(dir, PROVENANCE_FILENAME), JSON.stringify(stamp));
};

describe('phase source — copies of removed bundled skills', () => {
  it('skips a stamped copy whose bundled origin is no longer registered, and says why', async () => {
    expect(BUNDLED_SKILLS.some((s) => s.name === RETIRED)).toBe(false);
    const root = await mkdtemp(join(tmpdir(), 'phase-retired-'));
    await seed(join(root, PHASE_FLOW_DIR.implement, RETIRED), RETIRED, RETIRED);
    const live = BUNDLED_SKILLS[0]!.name;
    await seed(join(root, PHASE_FLOW_DIR.implement, live), live, live);
    const bus = createInMemoryEventBus();
    const logs: LogEvent[] = [];
    bus.subscribe((e: AppEvent) => {
      if (e.type === 'log') logs.push(e);
    });
    const source = createPhaseSkillSource({
      operatorSkillsRoot: abs(root),
      logger: createEventBusLogger({ eventBus: bus, clock: IsoTimestamp.now }),
    });

    const result = await source.getForFlow('implement');
    expect(result.ok && result.value.map((s) => s.name)).toEqual([live]);
    expect(logs.some((l) => l.level === 'warn' && JSON.stringify(l).includes(RETIRED))).toBe(true);
    const byName = await source.getByName(RETIRED);
    expect(byName.ok && byName.value).toBeUndefined();
  });

  it('still loads an unstamped hand-dropped folder that happens to share a removed name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase-retired-'));
    await seed(join(root, PHASE_FLOW_DIR.implement, RETIRED), RETIRED);
    const source = createPhaseSkillSource({
      operatorSkillsRoot: abs(root),
      logger: createEventBusLogger({ eventBus: createInMemoryEventBus(), clock: IsoTimestamp.now }),
    });

    const result = await source.getForFlow('implement');
    expect(result.ok && result.value.map((s) => s.name)).toEqual([RETIRED]);
  });
});
