/**
 * Behavioural fence for the readiness fan-out's `continue-on-error` wrapper.
 *
 * {@link wrapProviderContinue} decides, per provider sub-chain, whether a failure is a
 * provider-specific infrastructure hiccup (skip this provider, warn, let the fan-out continue)
 * or a real defect / cancellation (propagate, fail or cancel the whole run). The split is
 * security-relevant: an operator AbortError must NEVER be swallowed, and a contract/spawn
 * `invalid-state` must surface so a misconfiguration fails loudly rather than being hidden.
 *
 * These tests drive the wrapper against a raw `Element` stub — no leaves, no AI sessions — so the
 * decision table is asserted in isolation.
 */

import { describe, expect, it } from 'vitest';

import { wrapProviderContinue } from '@src/application/flows/readiness/flow.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';
import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ProbeError } from '@src/domain/value/error/probe-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AppEvent, BannerShowEvent } from '@src/business/observability/events.ts';
import { FIXED_PROJECT_ID } from '@tests/fixtures/domain.ts';

const CTX: ReadinessCtx = { projectId: FIXED_PROJECT_ID, tools: [], entries: {} };

const INNER_NAME = 'tool-claude-code';

const failedEntry = (error: DomainError): TraceEntry => ({
  elementName: INNER_NAME,
  status: 'failed',
  durationMs: 1,
  error,
});

/** Inner sub-chain stub that always fails with `error`, carrying a one-entry failure trace. */
const failingInner = (error: DomainError): Element<ReadinessCtx> => ({
  name: INNER_NAME,
  execute: (): Promise<ElementResult<ReadinessCtx>> =>
    Promise.resolve(Result.error({ error, trace: [failedEntry(error)] })),
});

/** Inner sub-chain stub that succeeds, threading `CTX` straight through. */
const succeedingInner = (): Element<ReadinessCtx> => ({
  name: INNER_NAME,
  execute: (): Promise<ElementResult<ReadinessCtx>> =>
    Promise.resolve(Result.ok({ ctx: CTX, trace: [{ elementName: INNER_NAME, status: 'completed', durationMs: 1 }] })),
});

const recordingBus = (): { bus: EventBus; events: AppEvent[] } => {
  const events: AppEvent[] = [];
  const bus = createInMemoryEventBus();
  bus.subscribe((e) => events.push(e));
  return { bus, events };
};

const run = async (
  inner: Element<ReadinessCtx>
): Promise<{ result: ElementResult<ReadinessCtx>; events: AppEvent[] }> => {
  const { bus, events } = recordingBus();
  const wrapped = wrapProviderContinue(bus, 'claude-code', inner);
  const result = await wrapped.execute(CTX);
  return { result, events };
};

const banners = (events: readonly AppEvent[]): BannerShowEvent[] =>
  events.filter((e): e is BannerShowEvent => e.type === 'banner-show');

describe('wrapProviderContinue — continue-vs-propagate decision', () => {
  it('exposes the inner sub-chain as its only child (so flattenLeaves still walks the plan)', () => {
    const inner = succeedingInner();
    const wrapped = wrapProviderContinue(createInMemoryEventBus(), 'claude-code', inner);
    expect(wrapped.children).toEqual([inner]);
  });

  it('passes a successful inner result straight through and emits no banner', async () => {
    const { result, events } = await run(succeedingInner());
    expect(result.ok).toBe(true);
    expect(banners(events)).toHaveLength(0);
  });

  it('SKIP path: a probe-error is swallowed — result is ok, a warn banner is emitted, inner trace preserved', async () => {
    const error = new ProbeError({ subCode: 'fs-read', message: 'cannot read .claude dir' });
    const { result, events } = await run(failingInner(error));

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The outer ctx flows on unchanged; the inner failure trace is preserved for the TUI rail.
      expect(result.value.ctx).toBe(CTX);
      expect(result.value.trace).toHaveLength(1);
      expect(result.value.trace[0]?.error).toBe(error);
    }

    const shown = banners(events);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.tier).toBe('warn');
    expect(shown[0]?.id).toContain('claude-code');
    expect(shown[0]?.cause).toBe('cannot read .claude dir');
  });

  it('SKIP path: a rate-limit error (CLI throttle past adapter retries) is swallowed with a warn banner', async () => {
    const error = new RateLimitError({ subCode: 'spawn-exit' });
    const { result, events } = await run(failingInner(error));

    expect(result.ok).toBe(true);
    expect(banners(events)).toHaveLength(1);
    expect(banners(events)[0]?.tier).toBe('warn');
  });

  it('PROPAGATE: an invalid-state error (contract / spawn failure) is NOT swallowed and emits no banner', async () => {
    const error = new InvalidStateError({ entity: 'chain', currentState: 'propose', attemptedAction: 'emit signal' });
    const { result, events } = await run(failingInner(error));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe(error);
      // The inner failure trace surfaces verbatim — the wrapper does not rewrite it.
      expect(result.error.trace[0]?.error).toBe(error);
    }
    expect(banners(events)).toHaveLength(0);
  });

  it('PROPAGATE: an AbortError (operator cancellation) is NEVER swallowed and emits no banner', async () => {
    const error = new AbortError({ elementName: INNER_NAME });
    const { result, events } = await run(failingInner(error));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe(error);
    expect(banners(events)).toHaveLength(0);
  });
});
