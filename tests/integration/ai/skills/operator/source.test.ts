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
import {
  createOperatorSkillSource,
  OPERATOR_PROVIDER_DIR,
  RALPHCTL_SKILL_PREFIX,
} from '@src/integration/ai/skills/operator/source.ts';

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
  providerDir: string,
  name: string,
  frontmatterName: string = name
): Promise<void> => {
  const dir = join(root, providerDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${frontmatterName}\ndescription: ${name} guidance\n---\n\n# ${name}\nbody\n`,
    'utf-8'
  );
};

describe('createOperatorSkillSource', () => {
  it('reads <root>/<providerDir>/*/SKILL.md for the resolved provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-source-'));
    await writeSkill(root, OPERATOR_PROVIDER_DIR['claude-code'], 'house-style');
    await writeSkill(root, OPERATOR_PROVIDER_DIR['claude-code'], 'commit-format');
    const { logger } = recordingLogger();

    const source = createOperatorSkillSource({
      operatorSkillsRoot: abs(root),
      provider: 'claude-code',
      logger,
    });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.map((s) => s.name).sort();
    // Install names carry the `ralphctl-` prefix so the adapter's exclude wildcard hides them.
    expect(names).toEqual([ns('commit-format'), ns('house-style')]);
    const houseStyle = result.value.find((s) => s.name === ns('house-style'));
    expect(houseStyle?.description).toBe('house-style guidance');
    expect(houseStyle?.content).toContain('# house-style');
  });

  it('does not double-prefix a folder the operator already named ralphctl-*', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-source-'));
    await writeSkill(root, OPERATOR_PROVIDER_DIR['claude-code'], 'ralphctl-prewired');
    const { logger } = recordingLogger();

    const source = createOperatorSkillSource({
      operatorSkillsRoot: abs(root),
      provider: 'claude-code',
      logger,
    });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.name)).toEqual(['ralphctl-prewired']);
  });

  it("ignores other providers' subdirs", async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-source-'));
    await writeSkill(root, OPERATOR_PROVIDER_DIR['claude-code'], 'claude-only');
    await writeSkill(root, OPERATOR_PROVIDER_DIR['openai-codex'], 'codex-only');
    await writeSkill(root, OPERATOR_PROVIDER_DIR['github-copilot'], 'copilot-only');
    const { logger } = recordingLogger();

    const source = createOperatorSkillSource({
      operatorSkillsRoot: abs(root),
      provider: 'openai-codex',
      logger,
    });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.name)).toEqual([ns('codex-only')]);
  });

  it('returns an empty list when the operator skills root is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-source-'));
    // No provider subdir written — the resolved provider's dir does not exist.
    const { logger, logs } = recordingLogger();

    const source = createOperatorSkillSource({
      operatorSkillsRoot: abs(join(root, 'does-not-exist')),
      provider: 'claude-code',
      logger,
    });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
    // A missing dir is the common no-config case — not even a warning.
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('emits a warn LogEvent for a contract-violating skill but still returns it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-source-'));
    await writeSkill(root, OPERATOR_PROVIDER_DIR['claude-code'], 'risky-skill');
    const { logger, logs } = recordingLogger();

    const violations: string[] = [];
    const warnIfContractViolated = (skill: Skill): void => {
      violations.push(skill.name);
      // A real guard logs through the same logger; emulate that so the LogEvent assertion holds.
      logger.named('skills.contract').warn('operator skill violates contract', { name: skill.name });
    };

    const source = createOperatorSkillSource({
      operatorSkillsRoot: abs(root),
      provider: 'claude-code',
      logger,
      warnIfContractViolated,
    });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Still installed — the operator owns their skills.
    expect(result.value.map((s) => s.name)).toEqual([ns('risky-skill')]);
    expect(violations).toEqual([ns('risky-skill')]);
    const warnLogs = logs.filter((l) => l.level === 'warn');
    expect(warnLogs.length).toBeGreaterThan(0);
    expect(warnLogs.some((l) => l.message.includes('operator skill violates contract'))).toBe(true);
  });

  it('skips an unreadable individual skill with a logged warning, keeping the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-source-'));
    const providerDir = OPERATOR_PROVIDER_DIR['claude-code'];
    await writeSkill(root, providerDir, 'good-skill');
    // Make `<root>/<providerDir>/wedged/SKILL.md` a DIRECTORY → read fails with EISDIR, skip it.
    await mkdir(join(root, providerDir, 'wedged', 'SKILL.md'), { recursive: true });
    const { logger, logs } = recordingLogger();

    const source = createOperatorSkillSource({
      operatorSkillsRoot: abs(root),
      provider: 'claude-code',
      logger,
    });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.name)).toEqual([ns('good-skill')]);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('not readable'))).toBe(true);
  });

  it('skips a malformed skill (frontmatter name mismatch) with a logged warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-source-'));
    const providerDir = OPERATOR_PROVIDER_DIR['claude-code'];
    await writeSkill(root, providerDir, 'good-skill');
    // Folder name vs frontmatter name disagree → parse error → skipped.
    await writeSkill(root, providerDir, 'mismatch-folder', 'different-name');
    const { logger, logs } = recordingLogger();

    const source = createOperatorSkillSource({
      operatorSkillsRoot: abs(root),
      provider: 'claude-code',
      logger,
    });
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.name)).toEqual([ns('good-skill')]);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('invalid'))).toBe(true);
  });

  it('getByName resolves a single operator skill and returns undefined for unknown names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-source-'));
    await writeSkill(root, OPERATOR_PROVIDER_DIR['claude-code'], 'house-style');
    const { logger } = recordingLogger();

    const source = createOperatorSkillSource({
      operatorSkillsRoot: abs(root),
      provider: 'claude-code',
      logger,
    });
    // getByName matches on the install (namespaced) name — that's what callers resolve against.
    const hit = await source.getByName(ns('house-style'));
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.value?.name).toBe(ns('house-style'));

    const miss = await source.getByName('nope');
    expect(miss.ok).toBe(true);
    if (!miss.ok) return;
    expect(miss.value).toBeUndefined();
  });
});
