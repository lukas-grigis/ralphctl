import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal, SetupScriptSignal, VerifyScriptSignal } from '@src/domain/signal.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { AiSignalEvent, AppEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { absolutePath, makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import {
  proposeDetectScriptsLeaf,
  type ProposeDetectScriptsLeafDeps,
} from '@src/application/flows/detect-scripts/leaves/propose.ts';
import type { DetectScriptsCtx } from '@src/application/flows/detect-scripts/ctx.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Audit-[10] contract grid for `proposeDetectScriptsLeaf` — audit-[09] detect-scripts contract.
 *
 * A `FakeProvider` writes the test payload directly to `session.signalsFile`, bypassing the
 * real AI CLI. The propose leaf then calls `validateSignalsFile` against `detectScriptsOutputContract`
 * and projects the result onto `ctx.proposal`. This exercises the full integration path from
 * provider → validate → project, under a real tmpdir, without spawning a CLI process.
 *
 * Contract rules:
 *  - All signal kinds (`setup-script`, `verify-script`, `verify-gates`, `note`) are optional.
 *  - At most one of each kind per spawn.
 *  - Empty signals array is a valid "no answer" response.
 *  - `migrations[0]` lifts the legacy bare-array shape into the v1 `{ schemaVersion, signals }` wrapper.
 */

const TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

type EmitPayload =
  | { readonly kind: 'signals'; readonly signals: readonly HarnessSignal[] }
  | { readonly kind: 'raw'; readonly body: string }
  | { readonly kind: 'omit' }
  | { readonly kind: 'spawn-error'; readonly error: DomainError }
  | { readonly kind: 'abort' };

const fakeProvider = (payload: EmitPayload): HeadlessAiProvider => ({
  async generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>> {
    if (payload.kind === 'spawn-error') return Result.error(payload.error);
    if (payload.kind === 'abort')
      throw new AbortError({ elementName: 'fake-detect-scripts-provider', reason: 'abort in test' });
    if (payload.kind === 'signals') {
      // Write the v1 wrapper so `validateSignalsFile` skips the legacy migration.
      const wrote = await writeJsonAtomic(String(session.signalsFile), {
        schemaVersion: 1,
        signals: payload.signals,
      });
      if (!wrote.ok) return Result.error(wrote.error);
    } else if (payload.kind === 'raw') {
      await fs.writeFile(String(session.signalsFile), payload.body, 'utf8');
    }
    // `omit` → never touch signalsFile → `validateSignalsFile` returns InvalidStateError.
    return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 });
  },
});

const captureBus = (eventBus = createInMemoryEventBus()): { events: AppEvent[]; eventBus: typeof eventBus } => {
  const events: AppEvent[] = [];
  eventBus.subscribe((e) => {
    events.push(e);
  });
  return { events, eventBus };
};

describe('proposeDetectScriptsLeaf — audit-[09] contract', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let runsRoot: ReturnType<typeof absolutePath>;
  let repoPath: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    runsRoot = absolutePath(join(String(root.root), 'runs'));
    repoPath = join(String(root.root), 'repo-a');
    await fs.mkdir(repoPath, { recursive: true });
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const buildDeps = (payload: EmitPayload, eventBus = createInMemoryEventBus()): ProposeDetectScriptsLeafDeps => ({
    provider: fakeProvider(payload),
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    signals: createInMemorySink<HarnessSignal>(),
    eventBus,
    logger: noopLogger,
    model: 'claude-sonnet-4-6',
    runsRoot,
  });

  const buildCtx = (): DetectScriptsCtx => {
    const project = makeProject();
    const repository = makeRepository({ path: repoPath, name: 'repo-a' });
    return {
      projectId: project.id,
      repository,
    };
  };

  const setupScriptSignal = (): SetupScriptSignal => ({
    type: 'setup-script',
    command: 'pnpm install',
    timestamp: TS,
  });

  const verifyScriptSignal = (): VerifyScriptSignal => ({
    type: 'verify-script',
    command: 'pnpm typecheck && pnpm lint && pnpm test',
    timestamp: TS,
  });

  // ── 1. Happy path — all valid signals present ────────────────────────────────

  it('ok: setup-script + verify-script → parsed, projected onto ctx, fanned to bus', async () => {
    const { events, eventBus } = captureBus();
    const deps = buildDeps({ kind: 'signals', signals: [setupScriptSignal(), verifyScriptSignal()] }, eventBus);
    const leaf = proposeDetectScriptsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);

    // Bus fan-out: every validated signal as a typed `ai-signal` event with source 'detect-scripts'.
    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['setup-script', 'verify-script']);
    for (const ev of aiSignals) expect(ev.source).toBe('detect-scripts');

    if (!result.ok) return;
    expect(result.value.ctx.proposal?.proposedSetupScript).toBe('pnpm install');
    expect(result.value.ctx.proposal?.proposedVerifyScript).toBe('pnpm typecheck && pnpm lint && pnpm test');
  });

  // ── 2. Empty signals — valid "no answer" ────────────────────────────────────

  it('ok: empty signals array — "no answer" is valid, proposal has no scripts', async () => {
    const deps = buildDeps({ kind: 'signals', signals: [] });
    const leaf = proposeDetectScriptsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.proposal?.proposedSetupScript).toBeUndefined();
    expect(result.value.ctx.proposal?.proposedVerifyScript).toBeUndefined();
    // runDir is always set on success.
    expect(result.value.ctx.proposal?.runDir).toBeDefined();
  });

  // ── 3. Duplicate signal kind — at-most-one refine fails ─────────────────────

  it('duplicate setup-script → ParseError (at-most-one violated)', async () => {
    const deps = buildDeps({ kind: 'signals', signals: [setupScriptSignal(), setupScriptSignal()] });
    const leaf = proposeDetectScriptsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('schema');
  });

  // ── 4. Invalid / unknown signal kind ─────────────────────────────────────────

  it('unknown signal kind (commit-message) → ParseError(schema-mismatch)', async () => {
    const unknown = [
      { type: 'commit-message', subject: 'feat: not a detect-scripts signal', timestamp: TS },
    ] as unknown as HarnessSignal[];
    const deps = buildDeps({ kind: 'signals', signals: unknown });
    const leaf = proposeDetectScriptsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('schema');
  });

  // ── 5. Missing required field on a valid type ─────────────────────────────────

  it('setup-script missing required command field → ParseError(schema-mismatch)', async () => {
    const malformed = [{ type: 'setup-script', timestamp: TS }] as unknown as HarnessSignal[];
    const deps = buildDeps({ kind: 'signals', signals: malformed });
    const leaf = proposeDetectScriptsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('schema');
  });

  // ── 6. Malformed JSON ──────────────────────────────────────────────────────────

  it('malformed JSON in signals.json → ParseError(invalid-json)', async () => {
    const deps = buildDeps({ kind: 'raw', body: '{ this is not valid json' });
    const leaf = proposeDetectScriptsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('malformed JSON');
  });

  // ── 7. signals.json not written ───────────────────────────────────────────────

  it('signals-missing: provider omits signals.json → InvalidStateError', async () => {
    const deps = buildDeps({ kind: 'omit' });
    const leaf = proposeDetectScriptsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.error.message).toContain('signals-missing');
  });

  // ── 8. Legacy bare-array migration ────────────────────────────────────────────

  it('migrations[0]: bare array → wraps into v1 envelope and validates', async () => {
    const { events, eventBus } = captureBus();
    // Write legacy shape: a bare JSON array without the `{ schemaVersion, signals }` wrapper.
    const legacyPayload = JSON.stringify([setupScriptSignal()]);
    const deps = buildDeps({ kind: 'raw', body: legacyPayload }, eventBus);
    const leaf = proposeDetectScriptsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['setup-script']);

    if (!result.ok) return;
    expect(result.value.ctx.proposal?.proposedSetupScript).toBe('pnpm install');
  });

  // ── 9. Spawn error ────────────────────────────────────────────────────────────

  it('spawn-error: leaf surfaces the spawn error, no validation attempted', async () => {
    const spawnError = new InvalidStateError({
      entity: 'provider',
      currentState: 'broken',
      attemptedAction: 'detect-scripts',
      message: 'simulated spawn failure',
    });
    const deps = buildDeps({ kind: 'spawn-error', error: spawnError });
    const leaf = proposeDetectScriptsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(spawnError);
  });

  // ── 10. AbortError propagation ────────────────────────────────────────────────

  it('abort: AbortError surfaces as an aborted Result out of the leaf (chain framework design)', async () => {
    // The provider throws AbortError mid-spawn (a TUI cancel). The `leaf` chain primitive
    // catches it and returns `Result.error({ error, trace })` with the trace entry marked
    // `aborted` — it does NOT re-throw. The runner's status machine routes that aborted Result
    // to the interrupted exit path, so cancellation stays a first-class Result, not an exception.
    const deps = buildDeps({ kind: 'abort' });
    const leaf = proposeDetectScriptsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
    expect(result.error.trace.at(-1)?.status).toBe('aborted');
  });
});
