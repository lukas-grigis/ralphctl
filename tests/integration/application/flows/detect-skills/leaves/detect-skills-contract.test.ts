import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal, SetupSkillProposalSignal, VerifySkillProposalSignal } from '@src/domain/signal.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { AiSignalEvent, AppEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createPublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import { absolutePath, makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import {
  proposeDetectSkillsLeaf,
  type ProposeDetectSkillsLeafDeps,
} from '@src/application/flows/detect-skills/leaves/propose.ts';
import type { DetectSkillsCtx } from '@src/application/flows/detect-skills/ctx.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Audit-[10] contract grid for `proposeDetectSkillsLeaf` — audit-[09] detect-skills contract.
 *
 * A `FakeProvider` writes the test payload directly to `session.signalsFile`, bypassing the
 * real AI CLI. The propose leaf then calls `validateSignalsFile` against `detectSkillsOutputContract`,
 * renders sidecars for the two optional `*-proposal` kinds, and projects the result onto
 * `ctx.proposal`. This exercises the full integration path from provider → validate → sidecar →
 * project, under a real tmpdir, without spawning a CLI process.
 *
 * Contract rules:
 *  - `setup-skill-proposal`, `verify-skill-proposal`, and `note` are all optional.
 *  - At most one of each kind per spawn.
 *  - Empty signals array is a valid "no skill needed" response.
 *  - `migrations[0]` lifts the legacy bare-array shape into the v1 `{ schemaVersion, signals }` wrapper.
 *  - Sidecars (`setup-skill.md`, `verify-skill.md`) are rendered from the accepted proposals.
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
      throw new AbortError({ elementName: 'fake-detect-skills-provider', reason: 'abort in test' });
    if (payload.kind === 'signals') {
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

/**
 * Real-disk WriteFile impl. The sidecar render path calls this for `setup-skill.md` and
 * `verify-skill.md`; errors are surfaced as `StorageError` matching production behaviour.
 */
const makeWriteFile = (): WriteFile => async (path, content) => {
  try {
    await fs.mkdir(join(String(path), '..'), { recursive: true });
    await fs.writeFile(String(path), content, 'utf8');
    return Result.ok(undefined);
  } catch (cause) {
    return Result.error(new StorageError({ subCode: 'io', message: 'writeFile failed', path: String(path), cause }));
  }
};

const captureBus = (eventBus = createInMemoryEventBus()): { events: AppEvent[]; eventBus: typeof eventBus } => {
  const events: AppEvent[] = [];
  eventBus.subscribe((e) => {
    events.push(e);
  });
  return { events, eventBus };
};

describe('proposeDetectSkillsLeaf — audit-[09] contract', () => {
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

  const buildDeps = (payload: EmitPayload, eventBus = createInMemoryEventBus()): ProposeDetectSkillsLeafDeps => ({
    provider: fakeProvider(payload),
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    publishSignal: createPublishSignal(eventBus, 'detect-skills'),
    writeFile: makeWriteFile(),
    logger: noopLogger,
    skillsAdapter: noopSkillsAdapter,
    model: 'claude-sonnet-4-6',
  });

  const buildCtx = (): DetectSkillsCtx => {
    const project = makeProject();
    const repository = makeRepository({ path: repoPath, name: 'repo-a' });
    // In production the chain's `allocate-run-dir-detect-skills` leaf stamps this onto ctx
    // before propose runs; these leaf-level tests stand it in directly.
    const runDir = absolutePath(join(String(runsRoot), 'detect-skills', 'test-run'));
    return {
      projectId: project.id,
      repository,
      proposal: { runDir },
    };
  };

  const setupSkillSignal = (): SetupSkillProposalSignal => ({
    type: 'setup-skill-proposal',
    content: 'Run `mise install` then `pnpm install` before editing.',
    timestamp: TS,
  });

  const verifySkillSignal = (): VerifySkillProposalSignal => ({
    type: 'verify-skill-proposal',
    content: 'Run `pnpm typecheck && pnpm lint && pnpm test` in sequence.',
    timestamp: TS,
  });

  // ── 1. Happy path — both proposals present ──────────────────────────────────

  it('ok: setup-skill + verify-skill → parsed, projected onto ctx, fanned to bus', async () => {
    const { events, eventBus } = captureBus();
    const deps = buildDeps({ kind: 'signals', signals: [setupSkillSignal(), verifySkillSignal()] }, eventBus);
    const leaf = proposeDetectSkillsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);

    // Bus fan-out: every validated signal as a typed `ai-signal` event with source 'detect-skills'.
    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['setup-skill-proposal', 'verify-skill-proposal']);
    for (const ev of aiSignals) expect(ev.source).toBe('detect-skills');

    if (!result.ok) return;
    expect(result.value.ctx.proposal?.proposedSetupSkill).toContain('mise install');
    expect(result.value.ctx.proposal?.proposedVerifySkill).toContain('pnpm typecheck');
  });

  // ── 2. Only one proposal — the other is absent ────────────────────────────────

  it('ok: only setup-skill-proposal → verify-skill absent from ctx', async () => {
    const { events, eventBus } = captureBus();
    const deps = buildDeps({ kind: 'signals', signals: [setupSkillSignal()] }, eventBus);
    const leaf = proposeDetectSkillsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['setup-skill-proposal']);

    if (!result.ok) return;
    expect(result.value.ctx.proposal?.proposedSetupSkill).toContain('mise install');
    expect(result.value.ctx.proposal?.proposedVerifySkill).toBeUndefined();
  });

  // ── 3. Empty signals — valid "no skill needed" ─────────────────────────────────

  it('ok: empty signals array — "no skill needed" is a valid response', async () => {
    const deps = buildDeps({ kind: 'signals', signals: [] });
    const leaf = proposeDetectSkillsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.proposal?.proposedSetupSkill).toBeUndefined();
    expect(result.value.ctx.proposal?.proposedVerifySkill).toBeUndefined();
    expect(result.value.ctx.proposal?.runDir).toBeDefined();
  });

  // ── 4. Duplicate signal kind — at-most-one refine fails ──────────────────────

  it('duplicate setup-skill-proposal → ParseError (at-most-one violated)', async () => {
    const deps = buildDeps({ kind: 'signals', signals: [setupSkillSignal(), setupSkillSignal()] });
    const leaf = proposeDetectSkillsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('schema');
  });

  // ── 5. Invalid / unknown signal kind ────────────────────────────────────────────

  it('unknown signal kind (refined-ticket) → ParseError(schema-mismatch)', async () => {
    const unknown = [
      { type: 'refined-ticket', body: 'not a skills signal', timestamp: TS },
    ] as unknown as HarnessSignal[];
    const deps = buildDeps({ kind: 'signals', signals: unknown });
    const leaf = proposeDetectSkillsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('schema');
  });

  // ── 6. Missing required field on a valid type ────────────────────────────────────

  it('setup-skill-proposal missing required content field → ParseError(schema-mismatch)', async () => {
    // `content` is required by setupSkillProposalSignalSchema but omitted here.
    const malformed = [{ type: 'setup-skill-proposal', timestamp: TS }] as unknown as HarnessSignal[];
    const deps = buildDeps({ kind: 'signals', signals: malformed });
    const leaf = proposeDetectSkillsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('schema');
  });

  // ── 7. Malformed JSON ────────────────────────────────────────────────────────────

  it('malformed JSON in signals.json → ParseError(invalid-json)', async () => {
    const deps = buildDeps({ kind: 'raw', body: '{ this is not valid json either' });
    const leaf = proposeDetectSkillsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('malformed JSON');
  });

  // ── 8. signals.json not written ──────────────────────────────────────────────────

  it('signals-missing: provider omits signals.json → InvalidStateError', async () => {
    const deps = buildDeps({ kind: 'omit' });
    const leaf = proposeDetectSkillsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.error.message).toContain('signals-missing');
  });

  // ── 9. Legacy bare-array migration ───────────────────────────────────────────────

  it('migrations[0]: bare array → wraps into v1 envelope and validates', async () => {
    const { events, eventBus } = captureBus();
    // Write legacy shape: a bare JSON array without the `{ schemaVersion, signals }` wrapper.
    const legacyPayload = JSON.stringify([setupSkillSignal()]);
    const deps = buildDeps({ kind: 'raw', body: legacyPayload }, eventBus);
    const leaf = proposeDetectSkillsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['setup-skill-proposal']);

    if (!result.ok) return;
    expect(result.value.ctx.proposal?.proposedSetupSkill).toContain('mise install');
  });

  // ── 10. Spawn error ──────────────────────────────────────────────────────────────

  it('spawn-error: leaf surfaces the spawn error, no validation attempted', async () => {
    const spawnError = new InvalidStateError({
      entity: 'provider',
      currentState: 'broken',
      attemptedAction: 'detect-skills',
      message: 'simulated spawn failure',
    });
    const deps = buildDeps({ kind: 'spawn-error', error: spawnError });
    const leaf = proposeDetectSkillsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(spawnError);
  });

  // ── 11. AbortError propagation ───────────────────────────────────────────────────

  it('abort: AbortError surfaces as an aborted Result out of the leaf (chain framework design)', async () => {
    // The provider throws AbortError mid-spawn (a TUI cancel). The `leaf` chain primitive
    // catches it and returns `Result.error({ error, trace })` with the trace entry marked
    // `aborted` — it does NOT re-throw. The runner's status machine routes that aborted Result
    // to the interrupted exit path, so cancellation stays a first-class Result, not an exception.
    const deps = buildDeps({ kind: 'abort' });
    const leaf = proposeDetectSkillsLeaf(deps);

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
    expect(result.error.trace.at(-1)?.status).toBe('aborted');
  });
});
