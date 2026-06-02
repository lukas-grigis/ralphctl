/**
 * Supplemental unit tests for escalation-policy.ts and escalation-map.ts — covers branches
 * not reached by the main escalation-policy.test.ts / escalation-map.test.ts files.
 *
 * Specific gaps:
 *   - escalation-policy.ts line 120: `recordTaskEscalation` failing inside `applyEscalation`
 *     for the `escalate` decision. The `decideEscalation` guard normally prevents this via
 *     `already-escalated`, but `applyEscalation` is public and must handle the failure.
 *   - escalation-map.ts: `warnEscalationMapSelfLoops` — one warn per self-loop entry;
 *     `mergeEscalationMap` — user override wins, user-only keys extend the ladder.
 */

import { describe, expect, it } from 'vitest';
import { applyEscalation, decideEscalation } from '@src/business/task/escalation-policy.ts';
import {
  DEFAULT_ESCALATION_MAP,
  mergeEscalationMap,
  warnEscalationMapSelfLoops,
} from '@src/business/task/escalation-map.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { Logger } from '@src/business/observability/logger.ts';

const fixedClock = (): IsoTimestamp => '2026-05-26T00:00:00.000Z' as IsoTimestamp;

const withEscalation = (task: InProgressTask, from: string, to: string): InProgressTask => {
  const stamped = recordTaskEscalation(task, from, to);
  if (!stamped.ok) throw stamped.error;
  return stamped.value;
};

const captureWarnLogger = (): { logger: Logger; warnings: string[] } => {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(msg: string) {
      warnings.push(msg);
    },
    error() {},
    named() {
      return logger;
    },
  };
  return { logger, warnings };
};

describe('applyEscalation — defensive failure branch (line 120)', () => {
  it('returns Result.error when recordTaskEscalation fails on the escalate path', () => {
    // Arrange: create a task that already has escalation fields stamped. Then pass an
    // `escalate` decision directly — bypassing the `decideEscalation` guard that would
    // normally catch this via `already-escalated`. This exercises the defensive
    // `if (!stamped.ok) return Result.error(stamped.error)` on line 120.
    const alreadyEscalated = withEscalation(
      makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      'claude-sonnet-4-6',
      'claude-opus-4-8'
    );
    const bus = createInMemoryEventBus();

    const result = applyEscalation({
      task: alreadyEscalated,
      decision: { kind: 'escalate', from: 'claude-opus-4-8', to: 'some-other-model' },
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBeTruthy();
    }
  });
});

describe('decideEscalation — user-only and edge cases', () => {
  it('user-only key (not in default map) adds a new rung and returns escalate', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const decision = decideEscalation({
      task,
      generatorModel: 'custom-finetuned-model-v1',
      flagOn: true,
      userMap: { 'custom-finetuned-model-v1': 'custom-finetuned-model-v2' },
    });

    expect(decision.kind).toBe('escalate');
    if (decision.kind === 'escalate') {
      expect(decision.from).toBe('custom-finetuned-model-v1');
      expect(decision.to).toBe('custom-finetuned-model-v2');
    }
  });

  it('returns nudge for a model unknown to both default and user maps (no rung above)', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const decision = decideEscalation({
      task,
      generatorModel: 'completely-unknown-model',
      flagOn: true,
      userMap: {},
    });

    expect(decision.kind).toBe('nudge');
    if (decision.kind === 'nudge') {
      expect(decision.currentModel).toBe('completely-unknown-model');
    }
  });

  it('budget-exhausted is returned before the mapping lookup when both conditions apply', () => {
    // Arrange: model HAS a mapping rung, but budget is exactly exhausted.
    // Budget check must win — so the operator sees the correct reason.
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: {},
    });

    expect(decision.kind).toBe('budget-exhausted');
    if (decision.kind === 'budget-exhausted') {
      expect(decision.attemptsUsed).toBe(decision.maxAttempts);
    }
  });

  it('already-escalated carries the from/to fields from the task', () => {
    const base = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const escalated = withEscalation(base, 'claude-haiku-4-5', 'claude-sonnet-4-6');
    const decision = decideEscalation({
      task: escalated,
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: {},
    });

    expect(decision.kind).toBe('already-escalated');
    if (decision.kind === 'already-escalated') {
      expect(decision.from).toBe('claude-haiku-4-5');
      expect(decision.to).toBe('claude-sonnet-4-6');
    }
  });
});

describe('warnEscalationMapSelfLoops', () => {
  it('emits one warn per self-loop entry', () => {
    const { logger, warnings } = captureWarnLogger();

    warnEscalationMapSelfLoops(
      {
        'claude-sonnet-4-6': 'claude-sonnet-4-6', // self-loop → warn
        'claude-opus-4-8': 'gpt-5.5', // not a self-loop → no warn
        'gpt-5-mini': 'gpt-5-mini', // self-loop → warn
      },
      logger
    );

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('claude-sonnet-4-6');
    expect(warnings[1]).toContain('gpt-5-mini');
  });

  it('emits no warns when the map has no self-loops', () => {
    const { logger, warnings } = captureWarnLogger();

    warnEscalationMapSelfLoops({ 'claude-haiku-4-5': 'claude-sonnet-4-6' }, logger);

    expect(warnings).toHaveLength(0);
  });

  it('emits no warns for an empty map', () => {
    const { logger, warnings } = captureWarnLogger();

    warnEscalationMapSelfLoops({}, logger);

    expect(warnings).toHaveLength(0);
  });
});

describe('mergeEscalationMap', () => {
  it('user key overrides the default rung', () => {
    const merged = mergeEscalationMap({ 'claude-sonnet-4-6': 'some-custom-model' });
    expect(merged['claude-sonnet-4-6']).toBe('some-custom-model');
    // Other default entries untouched
    expect(merged['claude-haiku-4-5']).toBe(DEFAULT_ESCALATION_MAP['claude-haiku-4-5']);
  });

  it('returns the default map contents unchanged when user map is empty', () => {
    const merged = mergeEscalationMap({});
    expect(merged).toStrictEqual(DEFAULT_ESCALATION_MAP);
  });

  it('user-only keys extend the ladder beyond the defaults', () => {
    const merged = mergeEscalationMap({ 'my-model': 'my-model-v2' });
    expect(merged['my-model']).toBe('my-model-v2');
    // Default entries still present
    expect(merged['claude-sonnet-4-6']).toBe(DEFAULT_ESCALATION_MAP['claude-sonnet-4-6']);
  });
});
