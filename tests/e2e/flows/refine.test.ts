import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { addTicket, type Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { PendingTicket } from '@src/domain/entity/ticket.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { IssueFetcher } from '@src/business/scm/issue-fetcher.ts';
import type { IssuePusher } from '@src/business/scm/issue-pusher.ts';
import type { IssueOriginRef } from '@src/domain/entity/project.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { parseHttpUrl } from '@src/domain/value/parsers/parse-http-url.ts';
import { makeDraftSprint, makePendingTicket } from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { passthroughRunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';
import { createRefineFlow } from '@src/application/flows/refine/flow.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { emptySkillSource, noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';

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

const draftWithPending = (
  count: number,
  decorate?: (i: number, t: PendingTicket) => PendingTicket
): { sprint: Sprint; tickets: PendingTicket[] } => {
  let sprint: Sprint = makeDraftSprint();
  const tickets: PendingTicket[] = [];
  for (let i = 0; i < count; i++) {
    const base = makePendingTicket({ title: `ticket-${i + 1}` });
    const t = decorate ? decorate(i, base) : base;
    tickets.push(t);
    const added = addTicket(sprint, t);
    if (!added.ok) throw new Error(`fixture: addTicket failed: ${added.error.message}`);
    sprint = added.value;
  }
  return { sprint, tickets };
};

/**
 * Fake `InteractiveAiProvider` that synchronously writes the supplied body to the AI's output
 * file. Records every call so tests can assert which prompt the AI received.
 */
interface FakeSessionState {
  readonly session: InteractiveAiProvider;
  readonly calls: Array<{ readonly input: InteractiveAiProviderInput; readonly promptBody: string }>;
}

const fakeInteractiveAi = (
  responder: (input: InteractiveAiProviderInput) => string | Promise<string>
): FakeSessionState => {
  const calls: Array<{ input: InteractiveAiProviderInput; promptBody: string }> = [];
  const session: InteractiveAiProvider = {
    async run(input) {
      const promptBody = await fs.readFile(String(input.promptFile), 'utf8');
      calls.push({ input, promptBody });
      const body = await responder(input);
      // audit-[09]: the AI writes `signals.json` directly under the unit root. `outputFile`
      // points at that path; we synthesise a valid `refined-ticket` envelope so the refine
      // contract validation succeeds end-to-end.
      const envelope = {
        schemaVersion: 1,
        signals: [{ type: 'refined-ticket', body, timestamp: '2026-05-22T10:00:00.000Z' }],
      };
      await fs.writeFile(String(input.outputFile), JSON.stringify(envelope), 'utf8');
      return Result.ok({});
    },
  };
  return { session, calls };
};

describe('createRefineFlow — interactive', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-refine-')));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const refinementRoot = (): AbsolutePath => {
    const r = AbsolutePath.parse(join(dir, 'refinement'));
    if (!r.ok) throw new Error('test setup');
    return r.value;
  };

  it('refines every pending ticket via interactive session, persists after each one', async () => {
    const { sprint, tickets } = draftWithPending(2);
    const { repo, saves } = inMemoryRepo(sprint);
    const eventBus = createInMemoryEventBus();

    // Respond uniformly per ticket; the prompt body captured in `fake.calls` is what we
    // assert against (it contains the ticket title for the run).
    const fake = fakeInteractiveAi(() => '# refined requirements');

    const flow = createRefineFlow(
      {
        sprintRepo: repo,
        interactiveAi: fake.session,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        writeFile: createAtomicWriteFile(),
        runInTerminal: passthroughRunInTerminal,
        eventBus,
        logger: noopLogger,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
        clock: () => '2026-01-01T00:00:00Z' as IsoTimestamp,
      },
      {
        sprintId: sprint.id,
        pendingTickets: tickets,
        providerId: 'claude-code',
        model: 'claude-sonnet-4-6',
        refinementRoot: refinementRoot(),
      }
    );

    const runner = createRunner({ id: 'r-refine', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(fake.calls).toHaveLength(2);
    // Sprint persisted once per ticket.
    expect(saves).toHaveLength(2);
    // Final sprint has both tickets approved.
    const last = saves.at(-1)!;
    expect(last.tickets.every((t) => t.status === 'approved')).toBe(true);
    // Each prompt body contained its ticket title.
    expect(fake.calls[0]?.promptBody).toContain('ticket-1');
    expect(fake.calls[1]?.promptBody).toContain('ticket-2');
  });

  it('threads issueContext into the prompt when fetcher returns a body', async () => {
    const link = (() => {
      const r = parseHttpUrl('link', 'https://github.com/x/y/issues/1');
      if (!r.ok) throw new Error('test setup');
      return r.value;
    })();
    const { sprint, tickets } = draftWithPending(1, (_i, t) => ({ ...t, link }));
    const { repo } = inMemoryRepo(sprint);
    const eventBus = createInMemoryEventBus();

    const issueFetcher: IssueFetcher = async () =>
      Result.ok({
        url: 'https://github.com/x/y/issues/1',
        title: 'Login broken on mobile Safari',
        body: 'Tap on login does nothing.',
        state: 'open',
        comments: [],
      });

    const fake = fakeInteractiveAi(() => '# refined');

    const flow = createRefineFlow(
      {
        sprintRepo: repo,
        interactiveAi: fake.session,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        writeFile: createAtomicWriteFile(),
        runInTerminal: passthroughRunInTerminal,
        eventBus,
        logger: noopLogger,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
        clock: () => '2026-01-01T00:00:00Z' as IsoTimestamp,
        issueFetcher,
      },
      {
        sprintId: sprint.id,
        pendingTickets: tickets,
        providerId: 'claude-code',
        model: 'claude-sonnet-4-6',
        refinementRoot: refinementRoot(),
      }
    );

    const runner = createRunner({ id: 'r-refine-ctx', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(fake.calls).toHaveLength(1);
    const promptBody = fake.calls[0]?.promptBody ?? '';
    expect(promptBody).toContain('Login broken on mobile Safari');
    expect(promptBody).toContain('Tap on login does nothing.');
  });

  it('soft-fails when issue fetch errors — proceeds without context', async () => {
    const link = (() => {
      const r = parseHttpUrl('link', 'https://github.com/x/y/issues/1');
      if (!r.ok) throw new Error('test setup');
      return r.value;
    })();
    const { sprint, tickets } = draftWithPending(1, (_i, t) => ({ ...t, link }));
    const { repo } = inMemoryRepo(sprint);
    const eventBus = createInMemoryEventBus();
    const eventLog: Array<{ level: string; message: string }> = [];
    eventBus.subscribe((e) => {
      if (e.type === 'log') eventLog.push({ level: e.level, message: e.message });
    });

    const issueFetcher: IssueFetcher = async () =>
      Result.error({
        code: 'storage-error',
        subCode: 'io',
        path: undefined,
        cause: undefined,
        name: 'StorageError',
        message: 'gh not installed',
      } as never);

    const fake = fakeInteractiveAi(() => '# refined');

    const flow = createRefineFlow(
      {
        sprintRepo: repo,
        interactiveAi: fake.session,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        writeFile: createAtomicWriteFile(),
        runInTerminal: passthroughRunInTerminal,
        eventBus,
        logger: noopLogger,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
        clock: () => '2026-01-01T00:00:00Z' as IsoTimestamp,
        issueFetcher,
      },
      {
        sprintId: sprint.id,
        pendingTickets: tickets,
        providerId: 'claude-code',
        model: 'claude-sonnet-4-6',
        refinementRoot: refinementRoot(),
      }
    );

    const runner = createRunner({ id: 'r-refine-soft', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(eventLog.some((e) => e.level === 'warn' && e.message.includes('fetch failed'))).toBe(true);
  });

  it('reviewer picks "approve & update" → IssuePusher.update is called with body + footer', async () => {
    const link = (() => {
      const r = parseHttpUrl('link', 'https://github.com/x/y/issues/42');
      if (!r.ok) throw new Error('test setup');
      return r.value;
    })();
    const { sprint, tickets } = draftWithPending(1, (_i, t) => ({ ...t, link }));
    const { repo, saves } = inMemoryRepo(sprint);
    const eventBus = createInMemoryEventBus();

    const refinedBody = '# refined requirements\n- a real acceptance criterion';
    const fake = fakeInteractiveAi(() => refinedBody);

    interface UpdateCall {
      readonly url: string;
      readonly body: string;
    }
    const updateCalls: UpdateCall[] = [];
    const createCalls: unknown[] = [];
    const issuePusher: IssuePusher = {
      async update(url, args) {
        updateCalls.push({ url, body: args.body });
        return Result.ok(undefined);
      },
      async create(origin, args) {
        createCalls.push({ origin, args });
        return Result.ok({ url: 'https://example.invalid/should-not-be-called' });
      },
    };

    const reviewBeforeApprove = async () => ({ accept: true, alsoUpdateOrigin: true });

    const flow = createRefineFlow(
      {
        sprintRepo: repo,
        interactiveAi: fake.session,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        writeFile: createAtomicWriteFile(),
        runInTerminal: passthroughRunInTerminal,
        eventBus,
        logger: noopLogger,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
        clock: () => '2026-01-01T00:00:00Z' as IsoTimestamp,
        issuePusher,
        reviewBeforeApprove,
      },
      {
        sprintId: sprint.id,
        pendingTickets: tickets,
        providerId: 'claude-code',
        model: 'claude-sonnet-4-6',
        refinementRoot: refinementRoot(),
      }
    );

    const runner = createRunner({ id: 'r-refine-update', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    // The pusher was used in update mode exactly once, on the existing link.
    expect(createCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(1);
    const call = updateCalls[0];
    expect(call?.url).toBe('https://github.com/x/y/issues/42');
    // Body carries the AI's content plus the "Refined by ralphctl" footer.
    expect(call?.body).toContain(refinedBody);
    expect(call?.body).toMatch(/Refined by ralphctl/);
    // Local sprint persisted with the approved ticket — the link stays untouched on an update.
    expect(saves).toHaveLength(1);
    const persistedTicket = saves[0]?.tickets[0];
    expect(persistedTicket?.status).toBe('approved');
    expect(String(persistedTicket?.link)).toBe('https://github.com/x/y/issues/42');
  });

  it('reviewer picks "approve & create" → IssuePusher.create runs and returned URL is attached to ticket.link', async () => {
    // Ticket starts WITHOUT a link; project carries a defaultIssueOrigin so the launcher would
    // have shown "Approve & create origin". The reviewer picks it.
    const { sprint, tickets } = draftWithPending(1);
    const { repo, saves } = inMemoryRepo(sprint);
    const eventBus = createInMemoryEventBus();

    const refinedBody = '# refined\n- something';
    const fake = fakeInteractiveAi(() => refinedBody);

    const defaultIssueOrigin: IssueOriginRef = { provider: 'github', owner: 'acme', repo: 'widgets' };
    const createdUrl = 'https://github.com/acme/widgets/issues/7';

    interface CreateCall {
      readonly origin: IssueOriginRef;
      readonly title: string;
      readonly body: string;
    }
    const createCalls: CreateCall[] = [];
    const updateCalls: unknown[] = [];
    const issuePusher: IssuePusher = {
      async update(url, args) {
        updateCalls.push({ url, args });
        return Result.ok(undefined);
      },
      async create(origin, args) {
        createCalls.push({ origin, title: args.title, body: args.body });
        return Result.ok({ url: createdUrl });
      },
    };

    const reviewBeforeApprove = async () => ({ accept: true, alsoUpdateOrigin: true });

    const flow = createRefineFlow(
      {
        sprintRepo: repo,
        interactiveAi: fake.session,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        writeFile: createAtomicWriteFile(),
        runInTerminal: passthroughRunInTerminal,
        eventBus,
        logger: noopLogger,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
        clock: () => '2026-01-01T00:00:00Z' as IsoTimestamp,
        issuePusher,
        defaultIssueOrigin,
        reviewBeforeApprove,
      },
      {
        sprintId: sprint.id,
        pendingTickets: tickets,
        providerId: 'claude-code',
        model: 'claude-sonnet-4-6',
        refinementRoot: refinementRoot(),
      }
    );

    const runner = createRunner({ id: 'r-refine-create', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    // Create-mode push exactly once, on the project's defaultIssueOrigin.
    expect(updateCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(1);
    const call = createCalls[0];
    expect(call?.origin).toEqual(defaultIssueOrigin);
    expect(call?.title).toBe(tickets[0]!.title);
    expect(call?.body).toContain(refinedBody);
    expect(call?.body).toMatch(/Refined by ralphctl/);
    // The chain attached the returned URL to ticket.link AND persisted it.
    expect(saves).toHaveLength(1);
    const persistedTicket = saves[0]?.tickets[0];
    expect(persistedTicket?.status).toBe('approved');
    expect(String(persistedTicket?.link)).toBe(createdUrl);
  });

  it('halts the chain when the AI exits without writing the output file', async () => {
    const { sprint, tickets } = draftWithPending(1);
    const { repo, saves } = inMemoryRepo(sprint);
    const eventBus = createInMemoryEventBus();

    const session: InteractiveAiProvider = {
      async run() {
        // Simulate a successful exit but leave outputFile absent.
        return Result.ok({});
      },
    };

    const flow = createRefineFlow(
      {
        sprintRepo: repo,
        interactiveAi: session,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        writeFile: createAtomicWriteFile(),
        runInTerminal: passthroughRunInTerminal,
        eventBus,
        logger: noopLogger,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
        clock: () => '2026-01-01T00:00:00Z' as IsoTimestamp,
      },
      {
        sprintId: sprint.id,
        pendingTickets: tickets,
        providerId: 'claude-code',
        model: 'claude-sonnet-4-6',
        refinementRoot: refinementRoot(),
      }
    );

    const runner = createRunner({ id: 'r-refine-no-output', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('failed');
    // No save persisted — the leaf erred before approveTicketRequirements ran.
    expect(saves).toHaveLength(0);
  });
});
