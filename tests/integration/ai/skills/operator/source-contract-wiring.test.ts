/**
 * Operator-skill contract-checker WIRING cover.
 *
 * The launcher (`src/application/ui/shared/launcher.ts`) builds the operator skill source with
 * `warnIfContractViolated: (skill) => checkContract(logger, skill.name, skill.content)` — the
 * real `warnIfContractViolated` from the skill-contract checker, adapted from its
 * `(logger, name, content)` signature to the source's `(skill) => void` warner shape.
 *
 * For a long time the launcher omitted that field entirely, so operator skills installed with NO
 * contract check — contradicting the documented "runs as a warning for operator skills" contract.
 * This test reconstructs the launcher's exact closure and proves the end-to-end path: a real
 * S2-violating operator skill (`git commit ...`) produces a real warn-level LogEvent through the
 * real checker, AND is still returned for install (the operator owns their skills — never abort).
 */

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
import { createOperatorSkillSource, OPERATOR_PROVIDER_DIR } from '@src/integration/ai/skills/operator/source.ts';
import { warnIfContractViolated as checkContract } from '@src/integration/ai/skills/_engine/skill-contract-checker.ts';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

const recordingLogger = (): { logger: ReturnType<typeof createEventBusLogger>; logs: LogEvent[] } => {
  const bus = createInMemoryEventBus();
  const logs: LogEvent[] = [];
  bus.subscribe((e: AppEvent) => {
    if (e.type === 'log') logs.push(e);
  });
  return { logger: createEventBusLogger({ eventBus: bus, clock: IsoTimestamp.now }), logs };
};

const writeSkill = async (root: string, providerDir: string, name: string, body: string): Promise<void> => {
  const dir = join(root, providerDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} guidance\n---\n\n${body}\n`,
    'utf-8'
  );
};

describe('operator skill source — launcher contract-check wiring', () => {
  it('runs the REAL contract checker (launcher closure) and warns on a git-commit violation, still installing the skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-wiring-'));
    // An S2 git-mutation directive — the checker must flag it.
    await writeSkill(
      root,
      OPERATOR_PROVIDER_DIR['claude-code'],
      'risky',
      '## Steps\n\n- `git commit -m "wip"` after each change'
    );
    const { logger, logs } = recordingLogger();

    // Reconstruct the launcher's exact wiring closure.
    const source = createOperatorSkillSource({
      operatorSkillsRoot: abs(root),
      provider: 'claude-code',
      logger,
      warnIfContractViolated: (skill: Skill) => {
        checkContract(logger, skill.name, skill.content);
      },
    });

    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Still installed — a contract violation is a WARNING, never an abort.
    expect(result.value.map((s) => s.name)).toEqual(['ralphctl-risky']);

    // A real warn-level LogEvent came out of the real checker, naming the S2 rule.
    const warnLogs = logs.filter((l) => l.level === 'warn' && l.message.includes('skill contract violation'));
    expect(warnLogs.length).toBeGreaterThan(0);
    expect(warnLogs.some((l) => JSON.stringify(l.meta ?? {}).includes('S2'))).toBe(true);
  });

  it('emits NO contract warning for a clean operator skill through the same closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-wiring-'));
    await writeSkill(
      root,
      OPERATOR_PROVIDER_DIR['claude-code'],
      'tidy',
      '## Advice\n\n- keep changes small and focused'
    );
    const { logger, logs } = recordingLogger();

    const source = createOperatorSkillSource({
      operatorSkillsRoot: abs(root),
      provider: 'claude-code',
      logger,
      warnIfContractViolated: (skill: Skill) => {
        checkContract(logger, skill.name, skill.content);
      },
    });

    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.name)).toEqual(['ralphctl-tidy']);
    expect(logs.filter((l) => l.level === 'warn' && l.message.includes('skill contract violation'))).toEqual([]);
  });
});
