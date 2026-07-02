import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { RefinedTicketSignal } from '@src/domain/signal.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { AiSignalEvent, AppEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { addTicket } from '@src/domain/entity/sprint.ts';
import { makeDraftSprint, makePendingTicket } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { RefineTicketInteractiveDeps } from '@src/application/flows/refine/leaves/refine-ticket-interactive.ts';
import { refineTicketInteractiveLeaf } from '@src/application/flows/refine/leaves/refine-ticket-interactive.ts';
import type { RefineCtx } from '@src/application/flows/refine/ctx.ts';

/**
 * Audit-[10] nine-branch grid against the audit-[09] refine contract.
 *
 * Each case constructs a tmpdir, points outputFile + signals.json at
 * `<root>/refinement/<slug>/`, optionally pre-writes `signals.json` (the leaf's synth step
 * skips when present — the same shape Wave 6 will produce when the prompt asks the AI to
 * write the contract artifact directly), and asserts on the leaf's `Result` plus the bus's
 * `ai-signal` fan-out. Refine has no sidecars; nothing else should land on disk beyond
 * `signals.json`.
 */

describe('refineTicketInteractiveLeaf — audit-[09] contract', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const unitDir = (): string => join(String(root.root), 'refinement', 'ticket');
  const promptFilePath = (): string => join(unitDir(), 'prompt.md');
  // audit-[09] post-Wave-6: the AI writes `signals.json` directly under the unit dir; the
  // legacy `requirements.md` body file is gone.
  const outputFilePath = (): string => join(unitDir(), 'signals.json');
  const signalsFilePath = (): string => join(unitDir(), 'signals.json');

  const ensureUnitDir = async (): Promise<void> => {
    await fs.mkdir(unitDir(), { recursive: true });
  };

  /**
   * Fake `InteractiveAiProvider` that succeeds without writing anything. Tests that want a
   * specific `signals.json` payload pre-write the file themselves; tests that want to
   * exercise the synth path write the `outputFile` before invoking the leaf and let the
   * synth step pick it up.
   */
  const fakeAi = (behaviour: (input: InteractiveAiProviderInput) => Promise<void>): InteractiveAiProvider => ({
    async run(input) {
      await behaviour(input);
      return Result.ok({});
    },
  });

  const buildDeps = (
    provider: InteractiveAiProvider,
    eventBus = createInMemoryEventBus()
  ): RefineTicketInteractiveDeps => {
    // Real disk write so the (currently empty) sidecar render path is exercised end-to-end.
    const writeFile: RefineTicketInteractiveDeps['writeFile'] = async (path, content) => {
      try {
        await fs.mkdir(join(String(path), '..'), { recursive: true });
        await fs.writeFile(String(path), content, 'utf8');
        return Result.ok(undefined);
      } catch (cause) {
        return Result.error({ message: String(cause) } as never);
      }
    };
    return {
      interactiveAi: provider,
      runInTerminal: async (fn) => fn(),
      logger: noopLogger,
      writeFile,
      eventBus,
      model: 'claude-sonnet-4-6',
      sprintId: 'test-sprint',
    };
  };

  const buildCtx = (): { ctx: RefineCtx; ticket: ReturnType<typeof makePendingTicket> } => {
    const ticket = makePendingTicket({ title: 'Test ticket' });
    let sprint = makeDraftSprint();
    const added = addTicket(sprint, ticket);
    if (!added.ok) throw new Error('addTicket setup failed');
    sprint = added.value;

    const unitRoot = AbsolutePath.parse(unitDir());
    const promptFile = AbsolutePath.parse(promptFilePath());
    const outputFile = AbsolutePath.parse(outputFilePath());
    if (!unitRoot.ok || !promptFile.ok || !outputFile.ok) throw new Error('path setup failed');

    return {
      ctx: {
        sprintId: sprint.id,
        sprint,
        currentUnitRoot: unitRoot.value,
        currentPromptFile: promptFile.value,
        currentOutputFile: outputFile.value,
      },
      ticket,
    };
  };

  const captureBus = (eventBus = createInMemoryEventBus()): { events: AppEvent[]; eventBus: typeof eventBus } => {
    const events: AppEvent[] = [];
    eventBus.subscribe((e) => {
      events.push(e);
    });
    return { events, eventBus };
  };

  const refinedTicketSignal = (body: string): RefinedTicketSignal => ({
    type: 'refined-ticket',
    body,
    timestamp: '2026-05-22T10:00:00.000Z' as RefinedTicketSignal['timestamp'],
  });

  // ── 1. Happy path ─────────────────────────────────────────────────────────────
  it('ok: validates pre-written wrapper, projects refined-ticket body, fans out to bus', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        signals: [
          { type: 'learning', text: 'this codebase uses zod', timestamp: '2026-05-22T10:00:00.000Z' },
          refinedTicketSignal('## Refined requirements\n\n- gate the import.'),
        ],
      }),
      'utf8'
    );
    const { events, eventBus } = captureBus();
    const provider = fakeAi(async () => {
      // No-op: signals.json is already in place.
    });
    const { ctx, ticket } = buildCtx();
    const leaf = refineTicketInteractiveLeaf(buildDeps(provider, eventBus), ticket);

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['learning', 'refined-ticket']);
    for (const ev of aiSignals) expect(ev.source).toBe('refine');

    if (!result.ok) return;
    // The sprint now has the ticket as approved with the refined-body persisted.
    expect(result.value.ctx.refinedTickets).toHaveLength(1);
    const approved = result.value.ctx.refinedTickets?.[0];
    expect(approved?.status).toBe('approved');
    expect(approved?.requirements).toBe('## Refined requirements\n\n- gate the import.');
  });

  // ── 1b. Abort signal threading ────────────────────────────────────────────────
  it('threads the leaf abort signal into the interactive provider', async () => {
    // Fix 1b: the leaf must forward its execute() signal as `abortSignal` so a TUI cancel can
    // tear the stdio-inherit child down (attachAbortKill). Without this the child runs on.
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({ schemaVersion: 1, signals: [refinedTicketSignal('## r\n\n- x')] }),
      'utf8'
    );
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const provider = fakeAi(async (input) => {
      seen = input.abortSignal;
    });
    const { ctx, ticket } = buildCtx();
    const leaf = refineTicketInteractiveLeaf(buildDeps(provider), ticket);

    const result = await leaf.execute(ctx, controller.signal);
    expect(result.ok).toBe(true);
    expect(seen).toBe(controller.signal);
  });

  // ── 2. signals.json missing ───────────────────────────────────────────────────
  it('signals-missing: surfaces a refine-specific actionable InvalidStateError', async () => {
    await ensureUnitDir();
    // AI exits cleanly but never writes signals.json.
    const provider = fakeAi(async () => {});
    const { ctx, ticket } = buildCtx();
    const leaf = refineTicketInteractiveLeaf(buildDeps(provider), ticket);

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    // The leaf rewrites the generic `signals-missing` token into an actionable, refine-framed
    // message — what happened (session ended early), what is safe (ticket unchanged), what to
    // do (re-run and let the AI finish).
    expect(result.error.error.message).toContain('Refinement not saved');
    expect(result.error.error.message).toContain('signals.json');
    expect(result.error.error.message).toContain('ticket is unchanged');
  });

  // ── 2b. Resilience: valid refined-ticket + malformed auxiliary signal ──────────
  it('resilience: keeps the refinement when only auxiliary signals are malformed', async () => {
    await ensureUnitDir();
    // One valid refined-ticket plus a malformed `decision` (carries `body` where the schema
    // wants `text`). The lenient refine contract drops the decision and keeps the refinement.
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        signals: [
          refinedTicketSignal('## Refined\n\n- the essential body survives'),
          { type: 'decision', body: 'wrong field — should be text', timestamp: '2026-05-22T10:00:00.000Z' },
        ],
      }),
      'utf8'
    );
    const { events, eventBus } = captureBus();
    const provider = fakeAi(async () => {});
    const { ctx, ticket } = buildCtx();
    const leaf = refineTicketInteractiveLeaf(buildDeps(provider, eventBus), ticket);

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Only the valid refined-ticket fanned out — the malformed decision was dropped.
    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['refined-ticket']);

    const approved = result.value.ctx.refinedTickets?.[0];
    expect(approved?.status).toBe('approved');
    expect(approved?.requirements).toBe('## Refined\n\n- the essential body survives');
  });

  // ── 3. Malformed JSON ─────────────────────────────────────────────────────────
  it('malformed JSON: surfaces ParseError(invalid-json)', async () => {
    await ensureUnitDir();
    await fs.writeFile(signalsFilePath(), '{ this is not json', 'utf8');
    const provider = fakeAi(async () => {});
    const { ctx, ticket } = buildCtx();
    const leaf = refineTicketInteractiveLeaf(buildDeps(provider), ticket);

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('malformed JSON');
  });

  // ── 4. Unknown signal kind with no valid refined-ticket → still fails ─────────
  it('ok with only a generator-only commit-message signal: surfaces ParseError', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        // `commit-message` is intentionally not part of the refine contract — the generator
        // emits it. The lenient contract drops it as an unknown element; with no surviving
        // `refined-ticket` the `.refine` then rejects, so this is still a real failure
        // (not a silent success) — the user must know nothing was refined.
        signals: [{ type: 'commit-message', subject: 'feat: x', timestamp: '2026-05-22T10:00:00.000Z' }],
      }),
      'utf8'
    );
    const provider = fakeAi(async () => {});
    const { ctx, ticket } = buildCtx();
    const leaf = refineTicketInteractiveLeaf(buildDeps(provider), ticket);

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('exactly one refined-ticket');
  });

  // ── 4b. Malformed refined-ticket (the essential signal) → still fails ─────────
  it('malformed refined-ticket: dropped, then rejected as zero refined-tickets', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        // The refined-ticket carries `text` where the schema wants `body`. The lenient parse
        // drops it like any malformed element — but a malformed ESSENTIAL signal must surface
        // as a real failure, which the exactly-one refinement enforces (zero survivors).
        signals: [{ type: 'refined-ticket', text: 'wrong field', timestamp: '2026-05-22T10:00:00.000Z' }],
      }),
      'utf8'
    );
    const provider = fakeAi(async () => {});
    const { ctx, ticket } = buildCtx();
    const leaf = refineTicketInteractiveLeaf(buildDeps(provider), ticket);

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('exactly one refined-ticket');
  });

  // ── 5a. Schema fails refine — zero refined-tickets ────────────────────────────
  it('ok with zero refined-ticket signals: refinement rejects', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        signals: [{ type: 'note', text: 'no proposal here', timestamp: '2026-05-22T10:00:00.000Z' }],
      }),
      'utf8'
    );
    const provider = fakeAi(async () => {});
    const { ctx, ticket } = buildCtx();
    const leaf = refineTicketInteractiveLeaf(buildDeps(provider), ticket);

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('exactly one refined-ticket');
  });

  // ── 5b. Schema fails refine — two refined-tickets ─────────────────────────────
  it('ok with two refined-ticket signals: refinement rejects', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        signals: [refinedTicketSignal('first'), refinedTicketSignal('second')],
      }),
      'utf8'
    );
    const provider = fakeAi(async () => {});
    const { ctx, ticket } = buildCtx();
    const leaf = refineTicketInteractiveLeaf(buildDeps(provider), ticket);

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('exactly one refined-ticket');
  });

  // ── 7. Legacy top-level-array migration ───────────────────────────────────────
  it('migrations[0] wraps legacy top-level array shape into the v1 envelope at load time', async () => {
    await ensureUnitDir();
    // In-flight pre-Wave-6 artifact on disk: a bare top-level `[refined-ticket]` array. The
    // contract's `migrations[0]` lifts it into `{ schemaVersion, signals }` at validation
    // time, so the leaf accepts the legacy shape without re-running the AI.
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify([refinedTicketSignal('# Refined\n\n- gate the import properly.')]),
      'utf8'
    );
    const provider = fakeAi(async () => {
      // No-op: signals.json is already in place.
    });
    const { events, eventBus } = captureBus();
    const { ctx, ticket } = buildCtx();
    const leaf = refineTicketInteractiveLeaf(buildDeps(provider, eventBus), ticket);

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['refined-ticket']);

    if (!result.ok) return;
    const approved = result.value.ctx.refinedTickets?.[0];
    expect(approved?.status).toBe('approved');
    expect(approved?.requirements).toBe('# Refined\n\n- gate the import properly.');
  });

  // ── 8. Spawn error ────────────────────────────────────────────────────────────
  it('spawn-error: leaf surfaces the spawn error, no validation attempted', async () => {
    await ensureUnitDir();
    const spawnError = new InvalidStateError({
      entity: 'provider',
      currentState: 'broken',
      attemptedAction: 'refine',
      message: 'simulated spawn failure',
    });
    const provider: InteractiveAiProvider = {
      async run() {
        return Result.error(spawnError);
      },
    };
    const { ctx, ticket } = buildCtx();
    const leaf = refineTicketInteractiveLeaf(buildDeps(provider), ticket);

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(spawnError);

    // No signals.json file should exist on disk — the provider failed before writing.
    await expect(fs.access(signalsFilePath())).rejects.toThrow();
  });

  // ── 9. Abort during spawn ─────────────────────────────────────────────────────
  it('abort: AbortError propagates transparently through the leaf', async () => {
    await ensureUnitDir();
    const provider: InteractiveAiProvider = {
      async run() {
        throw new AbortError({ elementName: 'mock-interactive', reason: 'aborted by fixture' });
      },
    };
    const { ctx, ticket } = buildCtx();
    const leaf = refineTicketInteractiveLeaf(buildDeps(provider), ticket);

    // The mock throws AbortError; the leaf primitive treats it as a DomainError (it has a
    // string `code`) and surfaces it via Result.error. The "transparent" contract is that
    // the error instance survives end-to-end without being swallowed or remapped.
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
  });
});
