import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { AskConfirmInput, Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { addTicket } from '@src/domain/entity/sprint.ts';
import { createTicket } from '@src/domain/entity/ticket.ts';
import { FIXED_NOW, makeActiveSprint, makeDraftSprint } from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createAddTicketsFlow } from '@src/application/flows/add-tickets/flow.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { ExternalIssue, IssueFetcher } from '@src/business/scm/issue-fetcher.ts';

const inMemoryRepo = (initial?: Sprint): { repo: SprintRepository; saves: Sprint[] } => {
  let current: Sprint | undefined = initial;
  const saves: Sprint[] = [];
  const repo = {
    async findById(id: SprintId) {
      if (current && current.id === id) return Result.ok(current);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
    async save(sprint: Sprint) {
      current = sprint;
      saves.push(sprint);
      return Result.ok(undefined);
    },
  } as SprintRepository;
  return { repo, saves };
};

interface ScriptedPromptOpts {
  readonly texts: readonly string[];
  readonly confirms: readonly boolean[];
  /** Optional override: throw on the i-th `askText` call (zero-based) with this error. */
  readonly textErrorAt?: { readonly index: number; readonly error: AbortError };
  /** Optional override: throw on the i-th `askConfirm` call (zero-based) with this error. */
  readonly confirmErrorAt?: { readonly index: number; readonly error: AbortError };
}

const scriptedPrompt = (
  opts: ScriptedPromptOpts
): { prompt: InteractivePrompt; textCalls: string[]; confirmCalls: string[] } => {
  let textIdx = 0;
  let confirmIdx = 0;
  const textCalls: string[] = [];
  const confirmCalls: string[] = [];
  const prompt: InteractivePrompt = {
    async askText(p: string) {
      textCalls.push(p);
      const i = textIdx++;
      if (opts.textErrorAt && i === opts.textErrorAt.index) return Result.error(opts.textErrorAt.error);
      const v = opts.texts[i];
      if (v === undefined) throw new Error(`scriptedPrompt: ran out of text answers (call #${String(i + 1)})`);
      return Result.ok(v);
    },
    async askTextArea(_p: string) {
      void _p;
      throw new Error('scriptedPrompt: askTextArea not used in add-tickets');
    },
    async askChoice<T>(_p: string, _options: ReadonlyArray<Choice<T>>) {
      void _p;
      void _options;
      throw new Error('scriptedPrompt: askChoice not used in add-tickets');
    },
    async askMultiChoice<T>(_p: string, _options: ReadonlyArray<Choice<T>>) {
      void _p;
      void _options;
      throw new Error('scriptedPrompt: askMultiChoice not used in add-tickets');
    },
    async askConfirm(input: AskConfirmInput) {
      confirmCalls.push(input.message);
      const i = confirmIdx++;
      if (opts.confirmErrorAt && i === opts.confirmErrorAt.index) return Result.error(opts.confirmErrorAt.error);
      const v = opts.confirms[i];
      if (v === undefined) throw new Error(`scriptedPrompt: ran out of confirm answers (call #${String(i + 1)})`);
      return Result.ok(v);
    },
  };
  return { prompt, textCalls, confirmCalls };
};

/** Fetcher that returns a canned issue for a given URL, or null / error otherwise. */
const cannedFetcher = (
  byUrl: Readonly<Record<string, ExternalIssue | null | StorageError>>
): { fetcher: IssueFetcher; calls: string[] } => {
  const calls: string[] = [];
  const fetcher: IssueFetcher = async (url) => {
    calls.push(url);
    const v = byUrl[url];
    if (v === undefined) return Result.ok(null);
    if (v instanceof StorageError) return Result.error(v);
    return Result.ok(v);
  };
  return { fetcher, calls };
};

describe('createAddTicketsFlow — manual entry (no fetcher wired)', () => {
  it('adds two tickets then exits via "no more" — full chain runs and persists', async () => {
    const sprint = makeDraftSprint({ tickets: [] });
    const { repo, saves } = inMemoryRepo(sprint);
    // No URL prompt (no fetcher). Per ticket: 3 askText + 2 askConfirm (Save? + Add another?).
    const { prompt } = scriptedPrompt({
      texts: ['first ticket', 'first desc', '', 'second ticket', '', ''],
      confirms: [true /*Save?*/, true /*Add another?*/, true /*Save?*/, false /*Add another? */],
    });

    const flow = createAddTicketsFlow({
      sprintRepo: repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
    });

    const runner = createRunner({ id: 'r-add-1', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.trace.map((e) => e.elementName)).toEqual([
      'load-sprint',
      'assert-sprint-status',
      'add-ticket-1',
      'add-ticket-2',
      'save-sprint',
    ]);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.tickets.map((t) => t.title)).toEqual(['first ticket', 'second ticket']);
    expect(saves[0]?.tickets[0]?.description).toBe('first desc');
    expect(saves[0]?.tickets[0]?.link).toBeUndefined();
    expect(runner.ctx.addedTickets).toHaveLength(2);
  });

  it('exits immediately on empty title — saves the sprint with no new tickets added', async () => {
    const sprint = makeDraftSprint({ tickets: [] });
    const { repo, saves } = inMemoryRepo(sprint);
    const { prompt } = scriptedPrompt({
      texts: [''], // user just hits enter on the first title prompt
      confirms: [],
    });

    const flow = createAddTicketsFlow({
      sprintRepo: repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
    });

    const runner = createRunner({ id: 'r-add-empty', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.trace.map((e) => e.elementName)).toEqual(['load-sprint', 'assert-sprint-status', 'save-sprint']);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.tickets).toHaveLength(0);
  });

  it('rejecting the Save confirm loops back without persisting that ticket', async () => {
    const sprint = makeDraftSprint({ tickets: [] });
    const { repo, saves } = inMemoryRepo(sprint);
    // Iteration 1: 3 text → Save? = false → loop (no add-ticket-1 trace entry).
    // Iteration 2: 3 text (title 'kept', desc '', link '') → Save? = true → Add another? = false.
    const { prompt } = scriptedPrompt({
      texts: ['rejected', 'wip', '', 'kept', '', ''],
      confirms: [false /*Save? rejected*/, true /*Save? kept*/, false /*Add another?*/],
    });

    const flow = createAddTicketsFlow({
      sprintRepo: repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
    });

    const runner = createRunner({ id: 'r-add-reject', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    // Only the second iteration emits an add-ticket trace entry — the rejected one is silent.
    expect(runner.trace.map((e) => e.elementName)).toEqual([
      'load-sprint',
      'assert-sprint-status',
      'add-ticket-1',
      'save-sprint',
    ]);
    expect(saves[0]?.tickets.map((t) => t.title)).toEqual(['kept']);
  });

  it('cancel mid-loop (askText abort) skips save — added tickets are NOT persisted', async () => {
    const sprint = makeDraftSprint({ tickets: [] });
    const { repo, saves } = inMemoryRepo(sprint);
    const abort = new AbortError({ elementName: 'add-ticket-2' });
    // ticket1 succeeds: 3 text + 2 confirms (Save?, Add another?=true). Ticket2 title prompt
    // (4th askText, zero-based 3) aborts.
    const { prompt } = scriptedPrompt({
      texts: ['first', '', '', /* ticket2 title aborts */ ''],
      confirms: [true /*Save?*/, true /*Add another?*/],
      textErrorAt: { index: 3, error: abort },
    });

    const flow = createAddTicketsFlow({
      sprintRepo: repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
    });

    const runner = createRunner({ id: 'r-add-abort', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('aborted');
    expect(saves).toHaveLength(0);
    expect(runner.trace.map((e) => `${e.elementName}:${e.status}`)).toEqual([
      'load-sprint:completed',
      'assert-sprint-status:completed',
      'add-ticket-1:completed',
      'add-ticket-2:failed',
      'save-sprint:skipped',
    ]);
  });

  it('use-case failure (e.g. malformed link) re-prompts the next iteration without crashing', async () => {
    const seed = makeDraftSprint({ tickets: [] });
    const ticketResult = createTicket({ title: 'pre-existing' });
    if (!ticketResult.ok) throw new Error('fixture: createTicket failed');
    const seeded = addTicket(seed, ticketResult.value);
    if (!seeded.ok) throw new Error('fixture: addTicket failed');
    const sprint = seeded.value;

    const { repo, saves } = inMemoryRepo(sprint);
    // Attempt 1: title 'good', desc '', link 'not a url' → Save? = true → useCase rejects link
    //   → ack press-enter (one extra askText) → continue.
    // Attempt 2 (renumbered add-ticket-2): title 'good', desc '', link '' → Save? = true →
    //   succeeds → Add another? = false.
    const { prompt } = scriptedPrompt({
      texts: ['good', '', 'not a url', /* ack */ '', 'good', '', ''],
      confirms: [true /*Save? attempt1*/, true /*Save? attempt2*/, false /*Add another?*/],
    });

    const flow = createAddTicketsFlow({
      sprintRepo: repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
    });

    const runner = createRunner({ id: 'r-add-retry', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.trace.map((e) => `${e.elementName}:${e.status}`)).toEqual([
      'load-sprint:completed',
      'assert-sprint-status:completed',
      'add-ticket-1:failed',
      'add-ticket-2:completed',
      'save-sprint:completed',
    ]);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.tickets).toHaveLength(2);
    expect(saves[0]?.tickets.map((t) => t.title)).toEqual(['pre-existing', 'good']);
  });

  it('fails fast when the loaded sprint is not draft — assert-sprint-status guards', async () => {
    const active = makeActiveSprint();
    const { repo, saves } = inMemoryRepo(active);
    const { prompt } = scriptedPrompt({ texts: [], confirms: [] });

    const flow = createAddTicketsFlow({
      sprintRepo: repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
    });

    const runner = createRunner({ id: 'r-add-bad-status', element: flow, initialCtx: { sprintId: active.id } });
    await runner.start();

    expect(runner.status).toBe('failed');
    expect(saves).toHaveLength(0);
    const failed = runner.trace.find((e) => e.status === 'failed');
    expect(failed?.error).toBeInstanceOf(InvalidStateError);
  });
});

describe('createAddTicketsFlow — URL-first prefill (issueFetcher wired)', () => {
  it('successful fetch pre-fills title/description; user accepts; ticket persisted', async () => {
    const sprint = makeDraftSprint({ tickets: [] });
    const { repo, saves } = inMemoryRepo(sprint);
    const url = 'https://github.com/acme/repo/issues/42';
    const { fetcher, calls } = cannedFetcher({
      [url]: { url, title: 'Fix the thing', body: 'Repro: do X', state: 'open', comments: [] },
    });
    // Per iteration with fetcher: 1 URL + 3 form text + 2 confirm. Then iteration 2: empty URL
    // → exits loop because we're past attempt 1 BUT addedSoFar > 0 means we don't break on
    // empty URL alone; we still drop into manual entry with an empty title → break.
    const { prompt } = scriptedPrompt({
      texts: [url, 'Fix the thing', 'Repro: do X', url, /* iter 2 */ '', ''],
      confirms: [true /*Save?*/, false /*Add another?*/],
    });

    const flow = createAddTicketsFlow({
      sprintRepo: repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
      issueFetcher: fetcher,
    });

    const runner = createRunner({ id: 'r-add-fetch', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(calls).toEqual([url]);
    expect(saves[0]?.tickets.map((t) => t.title)).toEqual(['Fix the thing']);
    expect(saves[0]?.tickets[0]?.description).toBe('Repro: do X');
    expect(saves[0]?.tickets[0]?.link).toBe(url);
  });

  it('fetch returns ok-null (unknown URL) → ack falls through to manual entry with URL kept on link', async () => {
    const sprint = makeDraftSprint({ tickets: [] });
    const { repo, saves } = inMemoryRepo(sprint);
    const url = 'https://example.com/not-an-issue';
    const { fetcher } = cannedFetcher({ [url]: null });
    // URL prompt, ack on the fallback warning, then manual form with link prefilled.
    const { prompt } = scriptedPrompt({
      texts: [url, /* ack */ '', 'Manual title', 'Manual desc', url],
      confirms: [true /*Save?*/, false /*Add another?*/],
    });

    const flow = createAddTicketsFlow({
      sprintRepo: repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
      issueFetcher: fetcher,
    });

    const runner = createRunner({ id: 'r-add-null', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(saves[0]?.tickets.map((t) => t.title)).toEqual(['Manual title']);
    expect(saves[0]?.tickets[0]?.link).toBe(url);
  });

  it('fetch error (network / auth) → ack falls through to manual entry', async () => {
    const sprint = makeDraftSprint({ tickets: [] });
    const { repo, saves } = inMemoryRepo(sprint);
    const url = 'https://github.com/acme/repo/issues/99';
    const { fetcher } = cannedFetcher({
      [url]: new StorageError({ subCode: 'io', message: 'gh CLI not authenticated' }),
    });
    const { prompt } = scriptedPrompt({
      texts: [url, /* ack */ '', 'Manual fallback', '', url],
      confirms: [true /*Save?*/, false /*Add another?*/],
    });

    const flow = createAddTicketsFlow({
      sprintRepo: repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
      issueFetcher: fetcher,
    });

    const runner = createRunner({ id: 'r-add-err', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(saves[0]?.tickets.map((t) => t.title)).toEqual(['Manual fallback']);
    expect(saves[0]?.tickets[0]?.link).toBe(url);
  });

  it('empty URL on first iteration exits the loop immediately', async () => {
    const sprint = makeDraftSprint({ tickets: [] });
    const { repo, saves } = inMemoryRepo(sprint);
    const { fetcher } = cannedFetcher({});
    const { prompt } = scriptedPrompt({ texts: [''], confirms: [] });

    const flow = createAddTicketsFlow({
      sprintRepo: repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
      issueFetcher: fetcher,
    });

    const runner = createRunner({ id: 'r-add-empty-url', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(saves[0]?.tickets).toHaveLength(0);
  });
});
