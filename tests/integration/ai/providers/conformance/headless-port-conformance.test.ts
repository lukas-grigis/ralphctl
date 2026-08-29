import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { type ProviderSpawnCall, makeProviderSpawn } from '@tests/fixtures/provider-spawn-fake.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { CodexProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { SpawnScript } from '@src/integration/ai/providers/_engine/scripted-spawn.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import { createCodexProvider } from '@src/integration/ai/providers/codex/headless.ts';
import { createCopilotProvider } from '@src/integration/ai/providers/copilot/headless.ts';
import { createOpencodeProvider } from '@src/integration/ai/providers/opencode/headless.ts';
import { createGrokProvider } from '@src/integration/ai/providers/grok/headless.ts';

/**
 * Port conformance for `HeadlessAiProvider`, one row per backend — the headless twin of
 * `interactive-port-conformance.test.ts`, asserting the same four contract clauses over the
 * surface that actually runs the implement loop.
 *
 * The per-adapter suites cover each CLI's own vocabulary in depth. This one covers what the PORT
 * promises regardless of vocabulary: the prompt is delivered out-of-band, declared roots are
 * mounted (or the over-grant is a named decision rather than an accident), effort matches the
 * provider's declaration, and a cancel becomes an `AbortError` with a signal on the wire.
 *
 * The rows are checked against `PROVIDER_TRAITS` at the bottom, so a fifth backend cannot land
 * without one.
 */

const CWD = absolutePath('/tmp/conformance-headless-cwd');
const SIBLING = absolutePath('/tmp/conformance-headless-sibling');

/** Marker that can only have come from the prompt body, so "never in argv" is checkable. */
const PROMPT_MARKER = 'SENTINEL-PROMPT-BODY';
const PROMPT = `${PROMPT_MARKER} ${'x'.repeat(200_000)}`;

/** See the interactive suite: a token no model id, path or flag could produce on its own. */
const EFFORT = 'zz-effort-probe';

/** Values of every `--add-dir <path>` pair — claude and codex. */
const spaceSeparatedRoots = (call: ProviderSpawnCall): ReadonlySet<string> =>
  new Set(call.args.filter((_, i) => call.args[i - 1] === '--add-dir'));

/** Values of every `--add-dir=<path>` argument — copilot. */
const equalsSeparatedRoots = (call: ProviderSpawnCall): ReadonlySet<string> =>
  new Set(
    call.args.flatMap((a) => {
      const match = /^--add-dir=(.+)$/.exec(a);
      return match === null ? [] : [match[1]!];
    })
  );

type RootGrant =
  | { readonly kind: 'per-root'; readonly read: (call: ProviderSpawnCall) => ReadonlySet<string> }
  /**
   * `opencode run` has no `--add-dir` equivalent — `--auto` is the only argv spelling that clears
   * the `external_directory` gate at all, so it grants MORE than the caller declared. Asserted
   * here as an intentional, named over-grant rather than quietly excused: the interactive adapter
   * fixed the same gap with a config grant, but `ProviderSpawn`'s options type carries no `env`,
   * so the headless side has no seam to inject one through. Documented behaviour, tracked
   * separately from this suite.
   */
  | { readonly kind: 'blanket-auto' }
  /**
   * Grok has no `--add-dir` and no `--auto`. `--sandbox off` is forced so operator config
   * cannot re-enable workspace/strict; extra roots are a named unrestricted over-grant —
   * assert no `--add-dir` and `--sandbox off`.
   */
  | { readonly kind: 'unrestricted' };

interface HeadlessRow {
  readonly provider: AiProvider;
  /**
   * Every row is handed `CodexProviderDeps`; the three that do not need its tempfile seams ignore
   * the extra fields, which keeps the table one shape instead of a union with a cast at every use.
   */
  readonly create: (deps: CodexProviderDeps) => HeadlessAiProvider;
  readonly model: string;
  /** How the prompt reaches the CLI. Either way it must never appear in argv. */
  readonly promptDelivery: 'stdin' | 'pointer';
  /** Filename the pointer-delivery adapter writes next to signals.json. */
  readonly promptFileName?: string;
  readonly rootGrant: RootGrant;
  /**
   * Whether the adapter mounts a root of its OWN, on top of what the session declared. Only the
   * pointer-delivery adapter has one: it wrote a file the CLI has to be allowed to read, and a
   * pointer at an unreadable path opens a session with no brief at all.
   */
  readonly mountsPromptFileDir: boolean;
}

const ROWS: readonly HeadlessRow[] = [
  {
    provider: 'claude-code',
    create: createClaudeProvider,
    model: PROVIDER_TRAITS['claude-code'].modelCatalog[0]!,
    promptDelivery: 'stdin',
    rootGrant: { kind: 'per-root', read: spaceSeparatedRoots },
    mountsPromptFileDir: false,
  },
  {
    provider: 'openai-codex',
    create: createCodexProvider,
    model: PROVIDER_TRAITS['openai-codex'].modelCatalog[0]!,
    promptDelivery: 'stdin',
    rootGrant: { kind: 'per-root', read: spaceSeparatedRoots },
    mountsPromptFileDir: false,
  },
  {
    provider: 'github-copilot',
    create: createCopilotProvider,
    model: PROVIDER_TRAITS['github-copilot'].modelCatalog[0]!,
    // Copilot has no stdin prompt slot, so the adapter writes `copilot-prompt.md` next to
    // signals.json and puts a pointer in argv. The documented inline-body fallback is reachable
    // ONLY when that write fails, which is why the success path can still assert argv is clean.
    promptDelivery: 'pointer',
    promptFileName: 'copilot-prompt.md',
    rootGrant: { kind: 'per-root', read: equalsSeparatedRoots },
    mountsPromptFileDir: true,
  },
  {
    provider: 'opencode',
    create: createOpencodeProvider,
    model: PROVIDER_TRAITS.opencode.modelCatalog[0]!,
    promptDelivery: 'stdin',
    rootGrant: { kind: 'blanket-auto' },
    mountsPromptFileDir: false,
  },
  {
    provider: 'xai-grok',
    create: createGrokProvider,
    model: PROVIDER_TRAITS['xai-grok'].modelCatalog[0]!,
    promptDelivery: 'pointer',
    promptFileName: 'grok-prompt.md',
    rootGrant: { kind: 'unrestricted' },
    mountsPromptFileDir: true,
  },
];

/** Poll until the adapter has actually spawned — `generate` does async work before it does. */
const waitForSpawn = async (calls: readonly ProviderSpawnCall[]): Promise<void> => {
  for (let i = 0; i < 200 && calls.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe.each(ROWS)('HeadlessAiProvider conformance — $provider', (row) => {
  let tmp: Awaited<ReturnType<typeof makeTmpRoot>>;
  let outputDir: AbsolutePath;
  let signalsFile: AbsolutePath;

  beforeEach(async () => {
    tmp = await makeTmpRoot();
    // A real directory: copilot writes its prompt file here and codex reads its forensic tempfile
    // from the same tree, so a fabricated path would only exercise their failure branches.
    outputDir = absolutePath(join(String(tmp.root), 'out'));
    signalsFile = absolutePath(join(String(outputDir), 'signals.json'));
    await mkdir(String(outputDir), { recursive: true });
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  const session = (overrides: Partial<AiSession> = {}): AiSession => ({
    prompt: PROMPT,
    cwd: CWD,
    additionalRoots: [SIBLING],
    outputDir,
    signalsFile,
    model: row.model,
    // READ_ONLY on purpose: it is the profile that does NOT set opencode's `--auto` by itself, so
    // an `--auto` in argv can only have come from the root grant the blanket-auto row asserts.
    permissions: READ_ONLY,
    ...overrides,
  });

  const run = async (overrides: Partial<AiSession> = {}, scripts: readonly SpawnScript[] = [{ exitCode: 0 }]) => {
    const cap = createCapturingBus();
    const fake = makeProviderSpawn(scripts);
    const provider = row.create({
      rateLimitRetries: 0,
      backoffSchedule: [0],
      eventBus: cap.bus,
      spawn: fake.spawn,
      mkTempPath: () => join(String(tmp.root), 'codex-body.txt'),
      readFile: () => Promise.resolve(''),
      unlink: () => Promise.resolve(),
    });
    return { cap, fake, promise: provider.generate(session(overrides)) };
  };

  it('delivers the prompt out-of-band — never inlined into argv, at any size', async () => {
    const { fake, promise } = await run();
    const result = await promise;
    expect(result.ok).toBe(true);

    const call = fake.calls[0]!;
    expect(call.args.join(' ')).not.toContain(PROMPT_MARKER);
    if (row.promptDelivery === 'stdin') {
      expect(call.stdin).toContain(PROMPT_MARKER);
      return;
    }
    // Pointer delivery: argv names the file the adapter wrote, and the body is on disk not in argv.
    expect(call.stdin).not.toContain(PROMPT_MARKER);
    expect(row.promptFileName).toBeDefined();
    expect(call.args.join(' ')).toContain(row.promptFileName);
  });

  it('mounts every writable root the session declared, or names its over-grant', async () => {
    const { fake, promise } = await run();
    await promise;

    const call = fake.calls[0]!;
    if (row.rootGrant.kind === 'blanket-auto') {
      expect(call.args).toContain('--auto');
      return;
    }
    if (row.rootGrant.kind === 'unrestricted') {
      expect(call.args).not.toContain('--add-dir');
      const sandboxIdx = call.args.indexOf('--sandbox');
      expect(sandboxIdx).toBeGreaterThanOrEqual(0);
      expect(call.args[sandboxIdx + 1]).toBe('off');
      return;
    }
    // cwd is implicitly mounted by every CLI, so `resolveWritableRoots` deliberately leaves it out.
    expect(row.rootGrant.read(call)).toEqual(new Set([String(SIBLING), String(outputDir)]));
  });

  it('mounts nothing extra when the session declares no roots outside cwd', async () => {
    // The counterpart the previous case cannot give: proof that the grant tracks what was declared
    // rather than being unconditional. For the blanket-auto row this is what shows `--auto` is
    // driven by the roots and not merely always present.
    const { fake, promise } = await run({ additionalRoots: [], outputDir: CWD, signalsFile });
    await promise;

    const call = fake.calls[0]!;
    if (row.rootGrant.kind === 'blanket-auto') {
      expect(call.args).not.toContain('--auto');
      return;
    }
    if (row.rootGrant.kind === 'unrestricted') {
      expect(call.args).not.toContain('--add-dir');
      const sandboxIdx = call.args.indexOf('--sandbox');
      expect(sandboxIdx).toBeGreaterThanOrEqual(0);
      expect(call.args[sandboxIdx + 1]).toBe('off');
      return;
    }
    // The prompt-file directory is the one root an adapter may add on its own behalf — it wrote
    // the file the pointer names. `signalsFile` still lives in the tmp tree here even though
    // `outputDir` was moved to cwd, so this is exactly that root and nothing else.
    const implicit = row.mountsPromptFileDir ? new Set([String(outputDir)]) : new Set<string>();
    expect(row.rootGrant.read(call)).toEqual(implicit);
  });

  it('forwards effort if and only if PROVIDER_TRAITS says this surface forwards it', async () => {
    const { fake, promise } = await run({ effort: EFFORT });
    await promise;

    expect(fake.calls[0]!.args.join(' ').includes(EFFORT)).toBe(
      PROVIDER_TRAITS[row.provider].effortForwarding.headless
    );
  });

  it('leaves an omitted effort out of argv entirely', async () => {
    const { fake, promise } = await run();
    await promise;

    expect(fake.calls[0]!.args.join(' ')).not.toContain(EFFORT);
  });

  it('propagates a caller abort as AbortError and reaches the child with SIGTERM', async () => {
    // Abort outranks the exit code the kill produces: a user cancel that surfaced as a generic
    // session error would be catchable by a downstream guard, and the chain would carry on past a
    // cancel. `hang: true` makes the abort the only thing that can end the child.
    const controller = new AbortController();
    const { fake, promise } = await run({ abortSignal: controller.signal }, [{ hang: true }]);
    await waitForSpawn(fake.calls);
    controller.abort();
    const result = await promise;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('aborted');
    expect(fake.calls[0]!.kills[0]).toBe('SIGTERM');
  });
});

describe('HeadlessAiProvider conformance coverage', () => {
  it('has one row per provider in PROVIDER_TRAITS', () => {
    expect(ROWS.map((r) => r.provider).sort()).toEqual(Object.keys(PROVIDER_TRAITS).sort());
  });

  it('documents codex resume as the one exemption from the per-root mount rule', async () => {
    // `codex/headless.ts` emits `-C` / `-s` / `--add-dir` only on a COLD spawn: a resumed rollout
    // inherits the sandbox it was created with, so re-declaring roots there would be inert at best.
    // The rows above exercise the cold path; this asserts the exemption is real rather than a gap
    // the suite quietly walks around.
    const cap = createCapturingBus();
    const fake = makeProviderSpawn([{ exitCode: 0 }]);
    const provider = createCodexProvider({
      rateLimitRetries: 0,
      backoffSchedule: [0],
      eventBus: cap.bus,
      spawn: fake.spawn,
      mkTempPath: () => '/tmp/conformance-codex-body.txt',
      readFile: () => Promise.resolve(''),
      unlink: () => Promise.resolve(),
    });

    await provider.generate({
      prompt: PROMPT,
      cwd: CWD,
      additionalRoots: [SIBLING],
      signalsFile: absolutePath('/tmp/conformance-headless-resume/signals.json'),
      model: PROVIDER_TRAITS['openai-codex'].modelCatalog[0]!,
      permissions: READ_ONLY,
      resume: 'rollout-abc' as SessionId,
    });

    expect(fake.calls[0]!.args).toContain('resume');
    expect(fake.calls[0]!.args).not.toContain('--add-dir');
  });
});
