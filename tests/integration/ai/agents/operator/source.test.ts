import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { AppEvent, LogEvent } from '@src/business/observability/events.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { RALPHCTL_AGENT_PREFIX } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { warnIfVague } from '@src/integration/ai/agents/_engine/agent-definition-quality.ts';
import { createOperatorAgentDefinitionSource } from '@src/integration/ai/agents/operator/source.ts';

const ns = (name: string): string => `${RALPHCTL_AGENT_PREFIX}${name}`;

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

const writeDefinition = async (
  root: string,
  name: string,
  frontmatterName: string = name,
  body = `# ${name}\nbody\n`
): Promise<void> => {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, `${name}.md`),
    `---\nname: ${frontmatterName}\ndescription: ${name} guidance\n---\n\n${body}`,
    'utf-8'
  );
};

describe('createOperatorAgentDefinitionSource', () => {
  it('reads <root>/*.md flat, with no per-provider subdirectory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-agents-'));
    await writeDefinition(root, 'house-reviewer');
    await writeDefinition(root, 'commit-writer');
    const { logger } = recordingLogger();

    const source = createOperatorAgentDefinitionSource({ operatorAgentDefinitionsRoot: abs(root), logger });
    const result = await source.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.map((d) => d.name).sort();
    expect(names).toEqual([ns('commit-writer'), ns('house-reviewer')]);
    const houseReviewer = result.value.find((d) => d.name === ns('house-reviewer'));
    expect(houseReviewer?.description).toBe('house-reviewer guidance');
    expect(houseReviewer?.content).toContain('# house-reviewer');
  });

  it('does not double-prefix a file the operator already named ralphctl-*', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-agents-'));
    await writeDefinition(root, 'ralphctl-prewired');
    const { logger } = recordingLogger();

    const source = createOperatorAgentDefinitionSource({ operatorAgentDefinitionsRoot: abs(root), logger });
    const result = await source.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((d) => d.name)).toEqual(['ralphctl-prewired']);
  });

  it('returns an empty list when the operator root is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-agents-'));
    const { logger, logs } = recordingLogger();

    const source = createOperatorAgentDefinitionSource({
      operatorAgentDefinitionsRoot: abs(join(root, 'does-not-exist')),
      logger,
    });
    const result = await source.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    'skips an unreadable individual definition with a logged warning, keeping the rest',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'operator-agents-'));
      await writeDefinition(root, 'good-definition');
      // Strip read permission from `<root>/wedged.md` → readFile fails with EACCES, skip it.
      await writeDefinition(root, 'wedged');
      await chmod(join(root, 'wedged.md'), 0o000);
      const { logger, logs } = recordingLogger();

      const source = createOperatorAgentDefinitionSource({ operatorAgentDefinitionsRoot: abs(root), logger });
      const result = await source.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.map((d) => d.name)).toEqual([ns('good-definition')]);
      expect(logs.some((l) => l.level === 'warn' && l.message.includes('not readable'))).toBe(true);
    }
  );

  it('skips a malformed definition (frontmatter name mismatch) with a logged warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-agents-'));
    await writeDefinition(root, 'good-definition');
    await writeDefinition(root, 'mismatch-file', 'different-name');
    const { logger, logs } = recordingLogger();

    const source = createOperatorAgentDefinitionSource({ operatorAgentDefinitionsRoot: abs(root), logger });
    const result = await source.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((d) => d.name)).toEqual([ns('good-definition')]);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('invalid'))).toBe(true);
  });

  it('getByName resolves a single operator definition and returns undefined for unknown names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-agents-'));
    await writeDefinition(root, 'house-reviewer');
    const { logger } = recordingLogger();

    const source = createOperatorAgentDefinitionSource({ operatorAgentDefinitionsRoot: abs(root), logger });
    const hit = await source.getByName(ns('house-reviewer'));
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.value?.name).toBe(ns('house-reviewer'));

    const miss = await source.getByName('nope');
    expect(miss.ok).toBe(true);
    if (!miss.ok) return;
    expect(miss.value).toBeUndefined();
  });

  it('a well-formed but vague definition raises a non-blocking warning yet is still returned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-agents-'));
    // Short, unstructured body — trips the quality warner's Q1 (too short) and Q2 (no structure).
    await writeDefinition(root, 'vague-agent', 'vague-agent', 'Be helpful.\n');
    const { logger, logs } = recordingLogger();

    const warnIfVagueGuard = (definition: AgentDefinition): void => warnIfVague(logger, definition);
    const source = createOperatorAgentDefinitionSource({
      operatorAgentDefinitionsRoot: abs(root),
      logger,
      warnIfVague: warnIfVagueGuard,
    });
    const result = await source.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Still returned for use — the operator owns their definitions.
    expect(result.value.map((d) => d.name)).toEqual([ns('vague-agent')]);
    const warnLogs = logs.filter((l) => l.level === 'warn');
    expect(warnLogs.some((l) => l.message.includes('agent definition quality concern'))).toBe(true);
  });
});
