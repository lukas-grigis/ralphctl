import { describe, expect, it } from 'vitest';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { AppEvent, LogEvent } from '@src/business/observability/events.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import {
  checkAgentDefinitionQuality,
  warnIfVague,
} from '@src/integration/ai/agents/_engine/agent-definition-quality.ts';

const SUFFICIENT_BODY = [
  '## Steps',
  '',
  '1. Read the requirement carefully before writing any code, so the change matches what was',
  '   actually asked for instead of a broader guess.',
  '2. Find the nearest existing pattern in this codebase and follow its naming, structure, and',
  '   error handling instead of introducing something new.',
  '3. Run the relevant check after each meaningful edit, and read its output before moving on.',
  '',
].join('\n');

const def = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: 'ralphctl-house-agent',
  description: 'House guidance for this repository.',
  content: SUFFICIENT_BODY,
  ...overrides,
});

describe('checkAgentDefinitionQuality', () => {
  it('passes a well-structured, sufficiently detailed definition', () => {
    const report = checkAgentDefinitionQuality(def());
    expect(report.pass).toBe(true);
    expect(report.concerns).toEqual([]);
  });

  it('flags a body under the minimum word count (Q1)', () => {
    const report = checkAgentDefinitionQuality(def({ content: 'Be helpful.\n' }));
    expect(report.pass).toBe(false);
    expect(report.concerns.some((c) => c.rule === 'Q1')).toBe(true);
  });

  it('flags a body with no headings or list items (Q2)', () => {
    const longProse =
      'This agent should generally try to be helpful and do a good job across a wide variety ' +
      'of situations without any particular structure or concrete steps to follow at all.';
    const report = checkAgentDefinitionQuality(def({ content: longProse }));
    expect(report.pass).toBe(false);
    expect(report.concerns.some((c) => c.rule === 'Q2')).toBe(true);
  });

  it('flags an evaluator-role definition that never mentions verification (Q3)', () => {
    const report = checkAgentDefinitionQuality(
      def({
        name: 'ralphctl-reviewer',
        description: 'Reviews changes and gives feedback.',
        content: '## Steps\n\n1. Read the change.\n2. Give your opinion on it.\n3. Be nice about it.\n',
      })
    );
    expect(report.pass).toBe(false);
    expect(report.concerns.some((c) => c.rule === 'Q3')).toBe(true);
  });

  it('does not flag Q3 for a non-evaluator definition even without verification vocabulary', () => {
    const report = checkAgentDefinitionQuality(def({ name: 'ralphctl-writer', description: 'Writes prose.' }));
    expect(report.concerns.some((c) => c.rule === 'Q3')).toBe(false);
  });

  it('passes an evaluator-role definition that concretely mentions verification', () => {
    const report = checkAgentDefinitionQuality(
      def({
        name: 'ralphctl-evaluator',
        description: 'Judges whether a change satisfies its acceptance criteria.',
        content: [
          '## Steps',
          '',
          '1. Read the acceptance criteria as written, without loosening them to match the diff.',
          '2. Run the test command the task specifies and read its output as evidence.',
          '3. Trace each criterion individually and report a clear pass or fail verdict.',
          '',
        ].join('\n'),
      })
    );
    expect(report.pass).toBe(true);
  });
});

describe('warnIfVague', () => {
  const recordingLogger = (): { logger: ReturnType<typeof createEventBusLogger>; logs: LogEvent[] } => {
    const bus = createInMemoryEventBus();
    const logs: LogEvent[] = [];
    bus.subscribe((e: AppEvent) => {
      if (e.type === 'log') logs.push(e);
    });
    return { logger: createEventBusLogger({ eventBus: bus, clock: IsoTimestamp.now }), logs };
  };

  it('logs one warning per concern for a vague definition', () => {
    const { logger, logs } = recordingLogger();
    warnIfVague(logger, def({ content: 'Be helpful.\n' }));
    const warnLogs = logs.filter((l) => l.level === 'warn');
    expect(warnLogs.length).toBeGreaterThan(0);
    expect(warnLogs.every((l) => l.message === 'agent definition quality concern')).toBe(true);
  });

  it('logs nothing for a well-formed definition', () => {
    const { logger, logs } = recordingLogger();
    warnIfVague(logger, def());
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });
});
