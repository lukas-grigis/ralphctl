import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type {
  AgentsMdProposalSignal,
  HarnessSignal,
  SetupSkillProposalSignal,
  VerifySkillProposalSignal,
} from '@src/domain/signal.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { AppEvent, AiSignalEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { absentState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { ReadinessProbeRegistry, ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { ToolArtifacts } from '@src/integration/ai/readiness/_engine/tool-artifacts.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { FIXED_NOW, absolutePath, makeRepository } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { evaluateReadiness } from '@src/integration/ai/readiness/_engine/evaluate.ts';
import {
  proposeReadinessLeaf,
  type ProposeReadinessLeafDeps,
} from '@src/application/flows/readiness/leaves/propose.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';

/**
 * Audit-[10] nine-branch grid against the audit-[09] readiness contract.
 *
 * Each case constructs a tmpdir, builds a {@link FakeReadinessProvider} (a hand-rolled
 * `HeadlessAiProvider` that writes the supplied `HarnessSignal[]` to `session.signalsFile`),
 * runs the propose leaf, and asserts on the leaf's `Result`, the bus's `ai-signal` fan-out,
 * and the sidecar files the harness emitted under the engine's per-run forensic dir.
 *
 * Readiness has THREE independent optional sidecars (no `exactlyOne` constraint), so the grid
 * also covers "only one sidecar present" and "all three present" paths beyond the baseline.
 */

const ts = (s: string): AgentsMdProposalSignal['timestamp'] => s as AgentsMdProposalSignal['timestamp'];

/**
 * Hand-rolled fake provider: the marker-dispatch fake at `tests/fixtures/fake-ai-provider.ts`
 * is convenient but routes everything through the XML-tag stdout parser. For the contract grid
 * we want exact control over the on-disk `signals.json` payload (the engine reads it back and
 * forwards verbatim into the propose leaf's contract validation step), so this fake writes the
 * supplied `HarnessSignal[]` straight to `session.signalsFile`. `signalsToEmit` may also be a
 * raw string for invalid-JSON tests; `null` means "write nothing" (signals-missing path).
 */
type EmitPayload =
  | { readonly kind: 'signals'; readonly signals: readonly HarnessSignal[] }
  | { readonly kind: 'raw'; readonly body: string }
  | { readonly kind: 'omit' }
  | { readonly kind: 'spawn-error'; readonly error: DomainError }
  | { readonly kind: 'abort' };

const fakeProvider = (payload: EmitPayload): HeadlessAiProvider => ({
  async generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>> {
    if (payload.kind === 'spawn-error') return Result.error(payload.error);
    if (payload.kind === 'abort') throw new AbortError({ elementName: 'fake-readiness-provider', reason: 'abort' });
    if (payload.kind === 'signals') {
      const wrote = await writeJsonAtomic(String(session.signalsFile), payload.signals);
      if (!wrote.ok) return Result.error(wrote.error);
    } else if (payload.kind === 'raw') {
      const wrote = await fs.writeFile(String(session.signalsFile), payload.body, 'utf8').then(() => undefined);
      void wrote;
    }
    // `omit` → never touch signalsFile. The engine's `consumeSignals` will surface that as a
    // domain error before the propose leaf reaches the contract step.
    return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 });
  },
});

const fakeProbeRegistry = (tool: AssistantTool): ReadinessProbeRegistry => {
  const probe: ReadinessProbe<ToolArtifacts> = {
    tool,
    async evaluate() {
      return Result.ok(absentState(FIXED_NOW));
    },
  };
  return { [tool]: probe } as ReadinessProbeRegistry;
};

/**
 * Real-disk WriteFile recorder. The propose leaf threads this into the audit-[09] sidecar
 * render path so tests can assert what landed on disk. Errors are surfaced as `StorageError`
 * so the leaf's behaviour matches production.
 */
const recordingWriteFile = (): { write: WriteFile; writes: Array<{ path: string; content: string }> } => {
  const writes: Array<{ path: string; content: string }> = [];
  const write: WriteFile = async (path, content) => {
    writes.push({ path: String(path), content });
    try {
      await fs.mkdir(join(String(path), '..'), { recursive: true });
      await fs.writeFile(String(path), content, 'utf8');
      return Result.ok(undefined);
    } catch (cause) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: 'recordingWriteFile failed',
          path: String(path),
          cause,
        })
      );
    }
  };
  return { write, writes };
};

const captureBus = (eventBus = createInMemoryEventBus()): { events: AppEvent[]; eventBus: typeof eventBus } => {
  const events: AppEvent[] = [];
  eventBus.subscribe((e) => {
    events.push(e);
  });
  return { events, eventBus };
};

describe('proposeReadinessLeaf — audit-[09] contract', () => {
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

  /**
   * Build the propose-leaf deps and the upstream ctx. The test pre-populates `repository`,
   * `tool`, and `probedState` so the leaf's input projection passes without running the
   * full chain.
   */
  const buildScene = async (
    payload: EmitPayload,
    eventBus = createInMemoryEventBus()
  ): Promise<{
    readonly deps: ProposeReadinessLeafDeps;
    readonly writer: ReturnType<typeof recordingWriteFile>;
    readonly ctx: ReadinessCtx;
  }> => {
    const repository = makeRepository({ path: repoPath, name: 'repo-a' });
    const probes = fakeProbeRegistry('claude-code');
    const stateResult = await evaluateReadiness({ probes }, repository, 'claude-code', FIXED_NOW);
    if (!stateResult.ok) throw new Error('probe setup failed');
    const writer = recordingWriteFile();
    const deps: ProposeReadinessLeafDeps = {
      provider: fakeProvider(payload),
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      writeFile: writer.write,
      eventBus,
      logger: noopLogger,
      cwd: absolutePath('/tmp/ralph/fake-readiness-cwd'),
      model: 'claude-sonnet-4-6',
    };
    // Pre-allocate a per-test run dir on disk so the propose leaf (which no longer allocates
    // its own runDir) has somewhere to land sidecars. Mirrors the chain composition where
    // `allocate-run-dir-<tool>` runs upstream of propose.
    const runDir = absolutePath(join(String(runsRoot), 'readiness', `test-${Math.random().toString(36).slice(2, 8)}`));
    await fs.mkdir(String(runDir), { recursive: true });
    const ctx: ReadinessCtx = {
      projectId: 'p1' as unknown as ReadinessCtx['projectId'],
      repository,
      tools: ['claude-code'],
      entries: { 'claude-code': { probedState: stateResult.value, runDir } },
    };
    return { deps, writer, ctx };
  };

  const findRunDirSidecars = async (relName: string): Promise<Array<{ path: string; content: string }>> => {
    // The engine generates a uuid-suffixed run dir under `<runsRoot>/readiness/`. List them all.
    const readinessDir = join(String(runsRoot), 'readiness');
    try {
      const entries = await fs.readdir(readinessDir, { withFileTypes: true });
      const matches: Array<{ path: string; content: string }> = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(readinessDir, entry.name, relName);
        try {
          const content = await fs.readFile(candidate, 'utf8');
          matches.push({ path: candidate, content });
        } catch {
          // sidecar not present in this run dir; skip.
        }
      }
      return matches;
    } catch {
      return [];
    }
  };

  const agentsMdSignal = (): AgentsMdProposalSignal => ({
    type: 'agents-md-proposal',
    tag: 'claude-md',
    content: '# repo-a\n\n## Build & Run\n- pnpm install\n',
    timestamp: ts('2026-05-22T10:00:00.000Z'),
  });

  const setupSkillSignal = (): SetupSkillProposalSignal => ({
    type: 'setup-skill-proposal',
    content: '# Setup\n\nRun `pnpm install` after every `package.json` change.\n',
    timestamp: ts('2026-05-22T10:00:00.000Z'),
  });

  const verifySkillSignal = (): VerifySkillProposalSignal => ({
    type: 'verify-skill-proposal',
    content: '# Verify\n\nRun `pnpm typecheck && pnpm lint && pnpm test`.\n',
    timestamp: ts('2026-05-22T10:00:00.000Z'),
  });

  // ── 1a. Happy path — only agents-md-proposal present (legacy readiness today) ─────
  it('ok: agents-md-proposal only — sidecar lands, skill-proposal sidecars absent', async () => {
    const { events, eventBus } = captureBus();
    const { deps, writer, ctx } = await buildScene({ kind: 'signals', signals: [agentsMdSignal()] }, eventBus);
    const leaf = proposeReadinessLeaf(deps, 'claude-code');

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);

    // Bus fan-out — every validated signal carried as a typed `ai-signal` event with source
    // 'readiness'.
    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['agents-md-proposal']);
    for (const ev of aiSignals) expect(ev.source).toBe('readiness');

    // Only agents-md-proposal.md should appear under the run dir; the two skill sidecars
    // stay absent (multiplicity 'optional').
    expect(await findRunDirSidecars('agents-md-proposal.md')).toHaveLength(1);
    expect(await findRunDirSidecars('setup-skill.md')).toHaveLength(0);
    expect(await findRunDirSidecars('verify-skill.md')).toHaveLength(0);

    // ctx.proposal carries the body.
    if (!result.ok) return;
    expect(result.value.ctx.entries['claude-code']?.proposal?.proposedContent).toContain('# repo-a');
    expect(result.value.ctx.entries['claude-code']?.proposal?.proposedSetupSkillBody).toBeUndefined();
    expect(result.value.ctx.entries['claude-code']?.proposal?.proposedVerifySkillBody).toBeUndefined();

    // The recording writer saw exactly one sidecar write (no skills) — sanity check the
    // sidecar render path is firing.
    const sidecarWrites = writer.writes.filter((w) => w.path.endsWith('.md'));
    expect(sidecarWrites).toHaveLength(1);
  });

  // ── 1b. Happy path — only setup-skill present (the brief explicitly asked for this case) ─
  it('ok: only setup-skill-proposal present — only setup-skill.md renders', async () => {
    const { events, eventBus } = captureBus();
    const { deps, writer, ctx } = await buildScene(
      { kind: 'signals', signals: [agentsMdSignal(), setupSkillSignal()] },
      eventBus
    );
    const leaf = proposeReadinessLeaf(deps, 'claude-code');

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['agents-md-proposal', 'setup-skill-proposal']);

    expect(await findRunDirSidecars('agents-md-proposal.md')).toHaveLength(1);
    expect(await findRunDirSidecars('setup-skill.md')).toHaveLength(1);
    expect(await findRunDirSidecars('verify-skill.md')).toHaveLength(0);

    if (!result.ok) return;
    expect(result.value.ctx.entries['claude-code']?.proposal?.proposedSetupSkillBody).toContain('Run `pnpm install`');
    expect(result.value.ctx.entries['claude-code']?.proposal?.proposedVerifySkillBody).toBeUndefined();

    // Sanity: writer recorded 2 sidecar writes (agents-md-proposal.md, setup-skill.md).
    expect(writer.writes.filter((w) => w.path.endsWith('.md'))).toHaveLength(2);
  });

  // ── 1c. Happy path — all three sidecar-source signals present ────────────────────
  it('ok: agents-md + setup-skill + verify-skill — all three sidecars render', async () => {
    const { events, eventBus } = captureBus();
    const { deps, writer, ctx } = await buildScene(
      { kind: 'signals', signals: [agentsMdSignal(), setupSkillSignal(), verifySkillSignal()] },
      eventBus
    );
    const leaf = proposeReadinessLeaf(deps, 'claude-code');

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual([
      'agents-md-proposal',
      'setup-skill-proposal',
      'verify-skill-proposal',
    ]);

    expect(await findRunDirSidecars('agents-md-proposal.md')).toHaveLength(1);
    expect(await findRunDirSidecars('setup-skill.md')).toHaveLength(1);
    expect(await findRunDirSidecars('verify-skill.md')).toHaveLength(1);

    if (!result.ok) return;
    expect(result.value.ctx.entries['claude-code']?.proposal?.proposedSetupSkillBody).toContain('Run `pnpm install`');
    expect(result.value.ctx.entries['claude-code']?.proposal?.proposedVerifySkillBody).toContain('pnpm typecheck');

    expect(writer.writes.filter((w) => w.path.endsWith('.md'))).toHaveLength(3);
  });

  // ── 2. signals.json missing ───────────────────────────────────────────────────
  it('signals-missing: provider omits signals.json → engine surfaces a domain error', async () => {
    const { deps, ctx } = await buildScene({ kind: 'omit' });
    const leaf = proposeReadinessLeaf(deps, 'claude-code');
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    // The engine's `consumeSignals` step trips first (it reads the temp signals file) — surfaces
    // a domain error before the contract validation step.
  });

  // ── 3. Malformed JSON ─────────────────────────────────────────────────────────
  it('malformed JSON: provider writes garbage to signals.json → engine domain error', async () => {
    const { deps, ctx } = await buildScene({ kind: 'raw', body: '{ this is not json' });
    const leaf = proposeReadinessLeaf(deps, 'claude-code');
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
  });

  // ── 4. Schema fails Zod (wrong shape) ─────────────────────────────────────────
  it('ok with refine-only refined-ticket signal: surfaces ParseError(schema-mismatch)', async () => {
    // `refined-ticket` is intentionally not part of the readiness contract. Post-Wave-6 the
    // filter step is gone; the contract validation rejects unknown kinds directly.
    const signals = [
      agentsMdSignal(),
      // Hand-craft a signal kind not in the readiness contract.
      {
        type: 'refined-ticket',
        body: 'should not happen',
        timestamp: ts('2026-05-22T10:00:00.000Z'),
      } as unknown as HarnessSignal,
    ];
    const { deps, ctx } = await buildScene({ kind: 'signals', signals });
    const leaf = proposeReadinessLeaf(deps, 'claude-code');
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('schema');
  });

  // ── 5. Missing required signal — readiness contract has NO `exactlyOne` ──────
  it('empty signals stream: leaf surfaces missing agents-md-proposal as InvalidStateError', async () => {
    // The readiness contract allows an empty signal array (no `exactlyOne` refinement), but
    // the propose leaf projects the `agents-md-proposal` body onto ctx — when no proposal is
    // present the leaf surfaces an InvalidStateError so the chain doesn't proceed with an
    // empty body.
    const { deps, ctx } = await buildScene({ kind: 'signals', signals: [] });
    const leaf = proposeReadinessLeaf(deps, 'claude-code');
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.error.message).toContain('no agents-md-proposal');
  });

  // ── 6. Multiple agents-md-proposals — contract permits (no exactlyOne) ────────
  it('ok: two agents-md-proposal signals — both surface on the bus, sidecar still renders', async () => {
    const second: AgentsMdProposalSignal = { ...agentsMdSignal(), content: '# second proposal\n' };
    const { events, eventBus } = captureBus();
    const { deps, writer, ctx } = await buildScene({ kind: 'signals', signals: [agentsMdSignal(), second] }, eventBus);
    const leaf = proposeReadinessLeaf(deps, 'claude-code');
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);
    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals).toHaveLength(2);
    // First-match write rule: the sidecar writes ONE file with the first signal's body.
    const sidecar = await findRunDirSidecars('agents-md-proposal.md');
    expect(sidecar).toHaveLength(1);
    expect(sidecar[0]?.content).toContain('# repo-a');
    void writer;
  });

  // ── 7. Legacy top-level-array migration via synth path ────────────────────────
  it('migrations[0]: contract validator accepts the legacy top-level array from the synth step', async () => {
    // The leaf's `synthesiseContractSignalsFile` writes the legacy shape (a bare array). The
    // contract's `migrations[0]` wraps it into `{ schemaVersion, signals }` before Zod parsing
    // — this happy-path test exercises that migration end-to-end. (All the other `ok:` cases
    // above also go through migrations[0] — this is the explicit "migrations work" assertion.)
    const { deps, ctx } = await buildScene({ kind: 'signals', signals: [agentsMdSignal()] });
    const leaf = proposeReadinessLeaf(deps, 'claude-code');
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);
    // The signals.json the leaf wrote should still be the legacy top-level-array shape; the
    // migration runs at READ time inside `validateSignalsFile`.
    const sidecarMatches = await findRunDirSidecars('agents-md-proposal.md');
    expect(sidecarMatches).toHaveLength(1);
  });

  // ── 8. Spawn error ────────────────────────────────────────────────────────────
  it('spawn-error: leaf surfaces the spawn error, no validation attempted', async () => {
    const spawnError = new InvalidStateError({
      entity: 'provider',
      currentState: 'broken',
      attemptedAction: 'readiness',
      message: 'simulated spawn failure',
    });
    const { deps, writer, ctx } = await buildScene({ kind: 'spawn-error', error: spawnError });
    const leaf = proposeReadinessLeaf(deps, 'claude-code');

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(spawnError);
    // No sidecars should be written.
    expect(writer.writes.filter((w) => w.path.endsWith('.md'))).toHaveLength(0);
  });

  // ── 9. Abort during spawn ─────────────────────────────────────────────────────
  it('abort: AbortError propagates transparently through the leaf', async () => {
    const { deps, ctx } = await buildScene({ kind: 'abort' });
    const leaf = proposeReadinessLeaf(deps, 'claude-code');
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
  });
});
