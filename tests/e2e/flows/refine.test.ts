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
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import type { PendingTicket } from '@src/domain/entity/ticket.ts';
import { readSprintDir } from '@tests/helpers/sprint-dir-snapshot.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { IssueFetcher } from '@src/business/scm/issue-fetcher.ts';
import type { IssuePusher } from '@src/business/scm/issue-pusher.ts';
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

/**
 * Fake `InteractiveAiProvider` that writes a caller-supplied `signals.json` payload verbatim.
 * `payload(input)` returns either the raw object to JSON-stringify into `outputFile`, or
 * `undefined` to leave the file absent entirely (simulating an AI that exited before writing).
 */
const fakeInteractiveAiRaw = (payload: (input: InteractiveAiProviderInput) => unknown): InteractiveAiProvider => ({
  async run(input) {
    const body = payload(input);
    if (body !== undefined) {
      await fs.writeFile(String(input.outputFile), JSON.stringify(body), 'utf8');
    }
    return Result.ok({});
  },
});

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

  /**
   * Real filesystem-backed sprint repo rooted at the test tmpdir, with `sprint` pre-persisted
   * to disk so refine's `load-sprint` reads it back. Filesystem-truth: every assertion reads
   * the sprint dir off disk, not from an in-memory double whose shape can drift from production.
   */
  const realFsRepo = async (sprint: Sprint): Promise<{ repo: SprintRepository; root: AbsolutePath }> => {
    const root = AbsolutePath.parse(dir);
    if (!root.ok) throw new Error('test setup');
    const repo = createFsSprintRepository({ root: root.value });
    const saved = await repo.save(sprint);
    if (!saved.ok) throw new Error(`fixture: initial save failed: ${saved.error.message}`);
    return { repo, root: root.value };
  };

  const readTicketsFromDisk = async (
    root: AbsolutePath,
    sprintId: SprintId
  ): Promise<ReadonlyArray<{ readonly title: string; readonly status: string; readonly requirements?: string }>> => {
    const snap = await readSprintDir(join(String(root), 'sprints', String(sprintId)));
    const json = snap.json<{ tickets: ReadonlyArray<{ title: string; status: string; requirements?: string }> }>(
      'sprint.json'
    );
    return json.tickets;
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

  it('reviewer picks "Post as comment" → IssuePusher.comment is called with body + signature', async () => {
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

    interface CommentCall {
      readonly url: string;
      readonly body: string;
    }
    const commentCalls: CommentCall[] = [];
    const issuePusher: IssuePusher = {
      async comment(url, args) {
        commentCalls.push({ url, body: args.body });
        return Result.ok(undefined);
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

    const runner = createRunner({ id: 'r-refine-comment', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    // The pusher posted a comment exactly once, on the existing link.
    expect(commentCalls).toHaveLength(1);
    const call = commentCalls[0];
    expect(call?.url).toBe('https://github.com/x/y/issues/42');
    // Body carries the AI's content plus the ralphctl signature naming the sprint.
    expect(call?.body).toContain(refinedBody);
    expect(call?.body).toMatch(/Posted by \[ralphctl\]/);
    expect(call?.body).toContain(`Sprint ${String(sprint.id)}`);
    // Local sprint persisted with the approved ticket — the link is untouched (no create path).
    expect(saves).toHaveLength(1);
    const persistedTicket = saves[0]?.tickets[0];
    expect(persistedTicket?.status).toBe('approved');
    expect(String(persistedTicket?.link)).toBe('https://github.com/x/y/issues/42');
  });

  it('reviewer EDITS the body then posts → the comment carries the edited body, not the AI original', async () => {
    // Regression for the silent-divergence bug: a reviewer who edits the AI's proposal and then
    // posts a comment must publish the EDITED text (the locally-persisted requirements), never the
    // AI's discarded pre-edit body.
    const link = (() => {
      const r = parseHttpUrl('link', 'https://github.com/x/y/issues/42');
      if (!r.ok) throw new Error('test setup');
      return r.value;
    })();
    const { sprint, tickets } = draftWithPending(1, (_i, t) => ({ ...t, link }));
    const { repo, saves } = inMemoryRepo(sprint);
    const eventBus = createInMemoryEventBus();

    const refinedBody = '# refined requirements\n- a WRONG criterion the reviewer deletes';
    const editedBody = '# refined requirements\n- the corrected acceptance criterion';
    const fake = fakeInteractiveAi(() => refinedBody);

    const commentCalls: Array<{ url: string; body: string }> = [];
    const issuePusher: IssuePusher = {
      async comment(url, args) {
        commentCalls.push({ url, body: args.body });
        return Result.ok(undefined);
      },
    };

    // The reviewer accepts but supplies an edited body — the use case persists it on the ticket.
    const reviewBeforeApprove = async () => ({ accept: true, alsoUpdateOrigin: true, body: editedBody });

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

    const runner = createRunner({ id: 'r-refine-edit-comment', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(commentCalls).toHaveLength(1);
    const call = commentCalls[0];
    // The posted comment carries the EDITED body and NOT the AI's discarded original.
    expect(call?.body).toContain(editedBody);
    expect(call?.body).not.toContain('WRONG criterion');
    // …and the locally-persisted requirements match what was posted (no divergence).
    const persistedTicket = saves[0]?.tickets[0];
    expect(persistedTicket?.status).toBe('approved');
    expect(persistedTicket?.requirements).toBe(editedBody);
  });

  it('non-interactive run with postRefinementComment → comments on a linked ticket without prompting', async () => {
    const link = (() => {
      const r = parseHttpUrl('link', 'https://github.com/x/y/issues/99');
      if (!r.ok) throw new Error('test setup');
      return r.value;
    })();
    const { sprint, tickets } = draftWithPending(1, (_i, t) => ({ ...t, link }));
    const { repo } = inMemoryRepo(sprint);
    const eventBus = createInMemoryEventBus();

    const refinedBody = '# refined\n- something';
    const fake = fakeInteractiveAi(() => refinedBody);

    const commentCalls: Array<{ url: string; body: string }> = [];
    const issuePusher: IssuePusher = {
      async comment(url, args) {
        commentCalls.push({ url, body: args.body });
        return Result.ok(undefined);
      },
    };

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
        // No reviewBeforeApprove — headless. The setting alone governs.
        postRefinementComment: true,
      },
      {
        sprintId: sprint.id,
        pendingTickets: tickets,
        providerId: 'claude-code',
        model: 'claude-sonnet-4-6',
        refinementRoot: refinementRoot(),
      }
    );

    const runner = createRunner({ id: 'r-refine-headless', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0]?.url).toBe('https://github.com/x/y/issues/99');
    expect(commentCalls[0]?.body).toContain(refinedBody);
  });

  it('non-interactive run with postRefinementComment but no ticket link → posts nothing', async () => {
    const { sprint, tickets } = draftWithPending(1);
    const { repo } = inMemoryRepo(sprint);
    const eventBus = createInMemoryEventBus();

    const fake = fakeInteractiveAi(() => '# refined\n- something');

    const commentCalls: unknown[] = [];
    const issuePusher: IssuePusher = {
      async comment(url, args) {
        commentCalls.push({ url, args });
        return Result.ok(undefined);
      },
    };

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
        postRefinementComment: true,
      },
      {
        sprintId: sprint.id,
        pendingTickets: tickets,
        providerId: 'claude-code',
        model: 'claude-sonnet-4-6',
        refinementRoot: refinementRoot(),
      }
    );

    const runner = createRunner({ id: 'r-refine-nolink', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(commentCalls).toHaveLength(0);
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

  // ── Filesystem-truth: happy / resilience / missing, asserted against real persistence ──

  it('filesystem-truth: a valid refined-ticket lands the ticket as approved with body on disk', async () => {
    const { sprint, tickets } = draftWithPending(1);
    const { repo, root } = await realFsRepo(sprint);
    const eventBus = createInMemoryEventBus();

    const refinedBody = '## Refined requirements\n\n- AC1: the body is persisted verbatim';
    const ai = fakeInteractiveAiRaw(() => ({
      schemaVersion: 1,
      signals: [{ type: 'refined-ticket', body: refinedBody, timestamp: '2026-05-22T10:00:00.000Z' }],
    }));

    const flow = createRefineFlow(
      {
        sprintRepo: repo,
        interactiveAi: ai,
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

    const runner = createRunner({ id: 'r-refine-fs-ok', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    // Read the sprint back off disk — the ticket is approved with the AI's body persisted.
    const onDisk = await readTicketsFromDisk(root, sprint.id);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]?.status).toBe('approved');
    expect(onDisk[0]?.requirements).toBe(refinedBody);
  });

  it('filesystem-truth: resilience — a malformed auxiliary signal is dropped, refinement survives', async () => {
    const { sprint, tickets } = draftWithPending(1);
    const { repo, root } = await realFsRepo(sprint);
    const eventBus = createInMemoryEventBus();
    const aiSignalTypes: string[] = [];
    eventBus.subscribe((e) => {
      if (e.type === 'ai-signal') aiSignalTypes.push(e.signal.type);
    });

    const refinedBody = '## Refined\n\n- the essential refined-ticket survives a bad sibling';
    const ai = fakeInteractiveAiRaw(() => ({
      schemaVersion: 1,
      signals: [
        { type: 'refined-ticket', body: refinedBody, timestamp: '2026-05-22T10:00:00.000Z' },
        // Malformed: `decision` carries `body` where the schema wants `text`. The exact drift
        // that previously discarded the whole refinement. Now it is dropped, not fatal.
        { type: 'decision', body: 'wrong field', timestamp: '2026-05-22T10:00:00.000Z' },
      ],
    }));

    const flow = createRefineFlow(
      {
        sprintRepo: repo,
        interactiveAi: ai,
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

    const runner = createRunner({ id: 'r-refine-fs-resilient', element: flow, initialCtx: { sprintId: sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    // Only the valid refined-ticket fanned out; the malformed decision was dropped.
    expect(aiSignalTypes).toEqual(['refined-ticket']);
    // The refinement still landed on disk.
    const onDisk = await readTicketsFromDisk(root, sprint.id);
    expect(onDisk[0]?.status).toBe('approved');
    expect(onDisk[0]?.requirements).toBe(refinedBody);
  });

  it('filesystem-truth: missing signals.json fails clearly and leaves the ticket pending on disk', async () => {
    const { sprint, tickets } = draftWithPending(1);
    const { repo, root } = await realFsRepo(sprint);
    const eventBus = createInMemoryEventBus();

    // AI exits cleanly but never writes signals.json (the user closed the session early).
    const ai = fakeInteractiveAiRaw(() => undefined);

    const flow = createRefineFlow(
      {
        sprintRepo: repo,
        interactiveAi: ai,
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

    const runner = createRunner({ id: 'r-refine-fs-missing', element: flow, initialCtx: { sprintId: sprint.id } });
    // Capture the failure error off the runner's event stream — this is the exact message the
    // TUI's failure card renders (`descriptor.error.message`).
    let failureMessage: string | undefined;
    runner.subscribe((event) => {
      if (event.type === 'failed') failureMessage = event.error.message;
    });
    await runner.start();

    // The flow fails — this is a real failure the user must know about, not a silent success.
    expect(runner.status).toBe('failed');
    // The surfaced error is the refine-specific, actionable signals-missing message.
    expect(failureMessage).toContain('Refinement not saved');
    expect(failureMessage).toContain('signals.json');
    // The ticket on disk is unchanged — still pending, no requirements body.
    const onDisk = await readTicketsFromDisk(root, sprint.id);
    expect(onDisk[0]?.status).toBe('pending');
    expect(onDisk[0]?.requirements ?? '').toBe('');
  });
});
