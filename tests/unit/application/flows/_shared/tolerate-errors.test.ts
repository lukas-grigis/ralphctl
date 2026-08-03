/**
 * Behavioural fence for the shared error-absorption wrapper.
 *
 * `tolerateErrors` is the one sanctioned way a chain keeps going past a failure. The decision
 * table it implements is security-relevant: a caller may only absorb what its own `tolerate`
 * predicate approves, and an operator `AbortError` must NEVER be absorbed regardless of what that
 * predicate says. These tests drive it against raw `Element` stubs — no leaves, no use cases.
 */

import { describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ProbeError } from '@src/domain/value/error/probe-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import { tolerateErrors } from '@src/application/flows/_shared/tolerate-errors.ts';
import type { AppEvent, BannerShowEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';

interface Ctx {
  readonly label: string;
}

const CTX: Ctx = { label: 'outer' };
const INNER_NAME = 'sub-chain';

const failedEntry = (error: DomainError): TraceEntry => ({
  elementName: INNER_NAME,
  status: 'failed',
  durationMs: 1,
  error,
});

const failingInner = (error: DomainError): Element<Ctx> => ({
  name: INNER_NAME,
  execute: (): Promise<ElementResult<Ctx>> => Promise.resolve(Result.error({ error, trace: [failedEntry(error)] })),
});

const succeedingInner = (): Element<Ctx> => ({
  name: INNER_NAME,
  execute: (): Promise<ElementResult<Ctx>> =>
    Promise.resolve(
      Result.ok({
        ctx: { label: 'inner' },
        trace: [{ elementName: INNER_NAME, status: 'completed', durationMs: 1 }],
      })
    ),
});

const recordingBus = (): { bus: EventBus; events: AppEvent[] } => {
  const events: AppEvent[] = [];
  const bus = createInMemoryEventBus();
  bus.subscribe((e) => events.push(e));
  return { bus, events };
};

const banners = (events: readonly AppEvent[]): BannerShowEvent[] =>
  events.filter((e): e is BannerShowEvent => e.type === 'banner-show');

const BANNER = { id: 'sub-chain-skipped', message: 'Sub-chain failed — skipping, the rest continues' };

describe('tolerateErrors', () => {
  it('exposes the inner element as its only child so flattenLeaves still walks the plan', () => {
    const inner = succeedingInner();
    const wrapped = tolerateErrors<Ctx>({ eventBus: createInMemoryEventBus(), tolerate: () => true }, inner);

    expect(wrapped.children).toEqual([inner]);
    expect(wrapped.name).toBe(`continue-on-error(${INNER_NAME})`);
  });

  it('passes a successful inner result through untouched and emits no banner', async () => {
    const { bus, events } = recordingBus();
    const wrapped = tolerateErrors<Ctx>({ eventBus: bus, tolerate: () => true, banner: BANNER }, succeedingInner());

    const result = await wrapped.execute(CTX);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ctx).toEqual({ label: 'inner' });
    expect(banners(events)).toHaveLength(0);
  });

  it('absorbs a tolerated failure, preserves the inner trace and flows the entering ctx on', async () => {
    const error = new ProbeError({ subCode: 'fs-read', message: 'cannot read the config dir' });
    const { bus, events } = recordingBus();
    const wrapped = tolerateErrors<Ctx>(
      { eventBus: bus, tolerate: (e) => e instanceof ProbeError, banner: BANNER },
      failingInner(error)
    );

    const result = await wrapped.execute(CTX);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The ctx that entered the wrapper flows on — the inner chain's partial mutations are dropped.
      expect(result.value.ctx).toBe(CTX);
      expect(result.value.trace).toHaveLength(1);
      expect(result.value.trace[0]?.error).toBe(error);
    }

    const shown = banners(events);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.tier).toBe('warn');
    expect(shown[0]?.id).toBe(BANNER.id);
    expect(shown[0]?.cause).toBe('cannot read the config dir');
  });

  it('absorbs silently when no banner is configured', async () => {
    const { bus, events } = recordingBus();
    const wrapped = tolerateErrors<Ctx>(
      { eventBus: bus, tolerate: () => true },
      failingInner(new ProbeError({ subCode: 'fs-read', message: 'nope' }))
    );

    const result = await wrapped.execute(CTX);

    expect(result.ok).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('propagates a failure the predicate rejects and emits no banner', async () => {
    const error = new ValidationError({ field: 'title', value: '', message: 'required' });
    const { bus, events } = recordingBus();
    const wrapped = tolerateErrors<Ctx>(
      { eventBus: bus, tolerate: (e) => e instanceof ProbeError, banner: BANNER },
      failingInner(error)
    );

    const result = await wrapped.execute(CTX);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe(error);
      // The inner failure trace surfaces verbatim — the wrapper never rewrites it.
      expect(result.error.trace[0]?.error).toBe(error);
    }
    expect(banners(events)).toHaveLength(0);
  });

  it('propagates an AbortError even when the predicate would tolerate everything', async () => {
    const error = new AbortError({ elementName: INNER_NAME });
    const { bus, events } = recordingBus();
    const wrapped = tolerateErrors<Ctx>({ eventBus: bus, tolerate: () => true, banner: BANNER }, failingInner(error));

    const result = await wrapped.execute(CTX);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe(error);
    expect(banners(events)).toHaveLength(0);
  });

  it('lets a thrown AbortError travel out untouched', async () => {
    const thrown = new AbortError({ elementName: INNER_NAME });
    const wrapped = tolerateErrors<Ctx>(
      { eventBus: createInMemoryEventBus(), tolerate: () => true },
      {
        name: INNER_NAME,
        execute: (): Promise<ElementResult<Ctx>> => Promise.reject(thrown),
      }
    );

    await expect(wrapped.execute(CTX)).rejects.toBe(thrown);
  });
});
