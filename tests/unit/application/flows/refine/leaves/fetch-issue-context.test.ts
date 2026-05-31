import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { IssueFetcher } from '@src/business/scm/issue-fetcher.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makePendingTicket } from '@tests/fixtures/domain.ts';
import { parseHttpUrl } from '@src/domain/value/parsers/parse-http-url.ts';
import { fetchIssueContextLeaf } from '@src/application/flows/refine/leaves/fetch-issue-context.ts';
import type { RefineCtx } from '@src/application/flows/refine/ctx.ts';

const captureLogEvents = (
  bus: ReturnType<typeof createInMemoryEventBus>
): Array<{ level: string; message: string }> => {
  const captured: Array<{ level: string; message: string }> = [];
  bus.subscribe((e) => {
    if (e.type === 'log') captured.push({ level: e.level, message: e.message });
  });
  return captured;
};

const baseCtx = (): RefineCtx => ({ sprintId: 'sprint-x' as RefineCtx['sprintId'] });

const httpsLink = (url: string) => {
  const r = parseHttpUrl('link', url);
  if (!r.ok) throw new Error('test setup');
  return r.value;
};

describe('fetchIssueContextLeaf', () => {
  it('no link → no-op, ctx unchanged besides currentTicket', async () => {
    const eventBus = createInMemoryEventBus();
    const ticket = makePendingTicket({ title: 'no-link' });
    const leaf = fetchIssueContextLeaf({ eventBus }, ticket);
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.currentTicket).toBe(ticket);
    expect(out.value.ctx.currentIssueContext).toBeUndefined();
  });

  it('link present but no fetcher injected → soft-fail with warn', async () => {
    const eventBus = createInMemoryEventBus();
    const eventLog = captureLogEvents(eventBus);
    const ticket = { ...makePendingTicket({ title: 't' }), link: httpsLink('https://github.com/x/y/issues/1') };
    const leaf = fetchIssueContextLeaf({ eventBus }, ticket);
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.currentIssueContext).toBeUndefined();
    expect(eventLog.some((e) => e.level === 'warn' && e.message.includes('no issueFetcher'))).toBe(true);
  });

  it('fetcher returns body → ctx.currentIssueContext set', async () => {
    const eventBus = createInMemoryEventBus();
    const ticket = { ...makePendingTicket({ title: 't' }), link: httpsLink('https://github.com/x/y/issues/1') };
    const issueFetcher: IssueFetcher = async () =>
      Result.ok({
        url: 'https://github.com/x/y/issues/1',
        title: 'Login broken',
        body: 'Tap does nothing',
        state: 'open',
        comments: [],
      });
    const leaf = fetchIssueContextLeaf({ eventBus, issueFetcher }, ticket);
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.currentIssueContext).toContain('Login broken');
    expect(out.value.ctx.currentIssueContext).toContain('Tap does nothing');
  });

  it('fetcher returns null (unknown host / 404) → no-op with info log', async () => {
    const eventBus = createInMemoryEventBus();
    const eventLog = captureLogEvents(eventBus);
    const ticket = { ...makePendingTicket({ title: 't' }), link: httpsLink('https://example.com/foo/bar') };
    const issueFetcher: IssueFetcher = async () => Result.ok(null);
    const leaf = fetchIssueContextLeaf({ eventBus, issueFetcher }, ticket);
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.currentIssueContext).toBeUndefined();
    expect(eventLog.some((e) => e.level === 'info' && e.message.includes('not recognised or issue not found'))).toBe(
      true
    );
  });

  it('fetcher errors → soft-fail (not error), warn log', async () => {
    const eventBus = createInMemoryEventBus();
    const eventLog = captureLogEvents(eventBus);
    const ticket = { ...makePendingTicket({ title: 't' }), link: httpsLink('https://github.com/x/y/issues/1') };
    const issueFetcher: IssueFetcher = async () =>
      Result.error(new StorageError({ subCode: 'io', message: 'gh not installed' }));
    const leaf = fetchIssueContextLeaf({ eventBus, issueFetcher }, ticket);
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.currentIssueContext).toBeUndefined();
    expect(eventLog.some((e) => e.level === 'warn' && e.message.includes('fetch failed'))).toBe(true);
  });
});
