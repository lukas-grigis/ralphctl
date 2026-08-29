import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { type InteractiveSpawnCall, makeInteractiveSpawn } from '@tests/fixtures/interactive-spawn-fake.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import { argvByteLength } from '@src/integration/ai/providers/_engine/argv-budget.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveProviderDeps } from '@src/integration/ai/providers/_engine/interactive-provider-deps.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';
import { createInteractiveClaudeProvider } from '@src/integration/ai/providers/claude/interactive.ts';
import { createInteractiveCodexProvider } from '@src/integration/ai/providers/codex/interactive.ts';
import { createInteractiveCopilotProvider } from '@src/integration/ai/providers/copilot/interactive.ts';
import { createInteractiveOpencodeProvider } from '@src/integration/ai/providers/opencode/interactive.ts';
import { createInteractiveGrokProvider } from '@src/integration/ai/providers/grok/interactive.ts';

/**
 * Port conformance for `InteractiveAiProvider`, one row per backend.
 *
 * The per-adapter suites next door assert each CLI's own argv spelling — the flags it needs and the
 * order it needs them in. What none of them can assert is the part of the port every adapter shares
 * and each one drifted from independently: the prompt travels as a pointer, declared roots are
 * granted or loudly refused, effort matches what the provider DECLARES it forwards, and a cancel
 * reaches the child. #278 is the case in point — the OpenCode adapter dropped `additionalRoots`
 * without a word for as long as it existed, because nothing checked all four adapters against the
 * same contract.
 *
 * The rows are checked against `PROVIDER_TRAITS` at the bottom, so a fifth backend cannot land
 * without one.
 */

const CWD = absolutePath('/tmp/conformance-interactive-cwd');
const SIBLING = absolutePath('/tmp/conformance-interactive-sibling');
const PROMPT_FILE = absolutePath('/tmp/conformance-interactive-io/prompt.md');
const OUTPUT_FILE = absolutePath('/tmp/conformance-interactive-io/output.md');
const IO_DIR = dirname(String(PROMPT_FILE));

/** Roots the shared engine folds from the input above — what every row must end up granting. */
const EXPECTED_ROOTS = new Set([String(CWD), String(SIBLING), IO_DIR]);

/**
 * A path that cannot be written as a glob pattern matching exactly itself. Adapters with an
 * `--add-dir` flag mount it verbatim; the one that expresses grants as glob keys must refuse.
 */
const UNEXPRESSIBLE_ROOT = absolutePath('/tmp/conformance-repo-[v2]');

/**
 * Effort value forwarded verbatim by every adapter that forwards effort at all (they all let the
 * CLI arbitrate the vocabulary). Deliberately not a real level: a substring search for `high` would
 * also hit a model id or a path, and this token can only have come from the effort field.
 */
const EFFORT = 'zz-effort-probe';

const STUB_PROMPT = 'Do the interactive thing.';
const stubReadFile = (): Promise<string> => Promise.resolve(STUB_PROMPT);

/** Values of every `--add-dir <path>` pair — claude and codex. */
const spaceSeparatedRoots = (call: InteractiveSpawnCall): ReadonlySet<string> =>
  new Set(call.args.filter((_, i) => call.args[i - 1] === '--add-dir'));

/** Values of every `--add-dir=<path>` argument — copilot. */
const equalsSeparatedRoots = (call: InteractiveSpawnCall): ReadonlySet<string> =>
  new Set(
    call.args.flatMap((a) => {
      const match = /^--add-dir=(.+)$/.exec(a);
      return match === null ? [] : [match[1]!];
    })
  );

/**
 * Directories the OpenCode config grant allows. Each root yields up to four keys (both separator
 * spellings × `*` and `**`, collapsing to two on POSIX), so the pattern tail is stripped back off.
 */
const configGrantedRoots = (call: InteractiveSpawnCall): ReadonlySet<string> => {
  const config = JSON.parse(call.env?.['OPENCODE_CONFIG_CONTENT'] ?? '{}') as {
    permission?: { external_directory?: Record<string, string> };
  };
  return new Set(
    Object.entries(config.permission?.external_directory ?? {})
      .filter(([, action]) => action === 'allow')
      .map(([pattern]) => pattern.replace(/[/\\]\*{1,2}$/, ''))
  );
};

interface InteractiveRow {
  readonly provider: AiProvider;
  readonly create: (deps: InteractiveProviderDeps) => InteractiveAiProvider;
  readonly model: string;
  /** Directories this spawn actually grants, however the CLI spells it. */
  readonly grantedRoots: (call: InteractiveSpawnCall) => ReadonlySet<string>;
  /**
   * Whether this adapter refuses a root it cannot express instead of granting it. Only the
   * config-grant adapter can be in that position — a flag-based one passes any string through.
   */
  readonly refusesUnexpressibleRoots: boolean;
  /**
   * Grok has no `--add-dir`; extra roots are a named over-grant (sandbox off). Spawn succeeding
   * with no `--add-dir` is the conformant answer.
   */
  readonly grantsUnrestricted?: boolean;
}

const ROWS: readonly InteractiveRow[] = [
  {
    provider: 'claude-code',
    create: createInteractiveClaudeProvider,
    model: PROVIDER_TRAITS['claude-code'].modelCatalog[0]!,
    grantedRoots: spaceSeparatedRoots,
    refusesUnexpressibleRoots: false,
  },
  {
    provider: 'openai-codex',
    create: createInteractiveCodexProvider,
    model: PROVIDER_TRAITS['openai-codex'].modelCatalog[0]!,
    grantedRoots: spaceSeparatedRoots,
    refusesUnexpressibleRoots: false,
  },
  {
    provider: 'github-copilot',
    create: createInteractiveCopilotProvider,
    model: PROVIDER_TRAITS['github-copilot'].modelCatalog[0]!,
    grantedRoots: equalsSeparatedRoots,
    refusesUnexpressibleRoots: false,
  },
  {
    provider: 'opencode',
    create: createInteractiveOpencodeProvider,
    model: PROVIDER_TRAITS.opencode.modelCatalog[0]!,
    grantedRoots: configGrantedRoots,
    refusesUnexpressibleRoots: true,
  },
  {
    provider: 'xai-grok',
    create: createInteractiveGrokProvider,
    model: PROVIDER_TRAITS['xai-grok'].modelCatalog[0]!,
    grantedRoots: () => new Set<string>(),
    refusesUnexpressibleRoots: false,
    grantsUnrestricted: true,
  },
];

describe.each(ROWS)('InteractiveAiProvider conformance — $provider', (row) => {
  const runSession = async (
    overrides: Partial<Parameters<InteractiveAiProvider['run']>[0]> = {},
    readFile: () => Promise<string> = stubReadFile
  ) => {
    const cap = createCapturingBus();
    const fake = makeInteractiveSpawn();
    const provider = row.create({ eventBus: cap.bus, spawn: fake.spawn, readFile });
    const runPromise = provider.run({
      cwd: CWD,
      additionalRoots: [SIBLING],
      promptFile: PROMPT_FILE,
      outputFile: OUTPUT_FILE,
      model: row.model,
      ...overrides,
    });
    return { cap, fake, runPromise };
  };

  it('passes a pointer at the prompt file — the body never rides argv, at any size', async () => {
    // The regression this contract exists for: a rendered prompt blew the 32,767-byte Windows
    // command line and the session died with `spawn ENAMETOOLONG` before the CLI ever started.
    const body = `SENTINEL-BODY-${'x'.repeat(200_000)}`;
    const { fake, runPromise } = await runSession({}, () => Promise.resolve(body));
    fake.emitExit(0);
    await runPromise;

    const call = fake.calls[0]!;
    expect(call.args.some((a) => a.includes(String(PROMPT_FILE)))).toBe(true);
    expect(call.args.join('\x00')).not.toContain('SENTINEL-BODY-');
    expect(argvByteLength(call.command, call.args)).toBeLessThan(2_000);
    // Nothing smuggles the body through the environment either.
    expect(Object.values(call.env ?? {}).join('\x00')).not.toContain('SENTINEL-BODY-');
  });

  it('grants every root the engine folded — cwd, additionalRoots, and the prompt / output dir', async () => {
    const { fake, runPromise } = await runSession();
    fake.emitExit(0);
    const result = await runPromise;
    expect(result.ok).toBe(true);

    if (row.grantsUnrestricted === true) {
      expect(fake.calls[0]!.args).not.toContain('--add-dir');
      return;
    }
    expect(row.grantedRoots(fake.calls[0]!)).toEqual(EXPECTED_ROOTS);
  });

  it('honours a root it cannot express, or refuses it loudly — never silently drops it', async () => {
    // `AiSession.additionalRoots` / `InteractiveAiProviderInput.additionalRoots`: an adapter that
    // cannot mount a root MUST surface InvalidStateError rather than quietly using only what it
    // can. Both arms are conformant; a granted-nothing-and-carried-on arm is not.
    const { fake, runPromise } = await runSession({ additionalRoots: [SIBLING, UNEXPRESSIBLE_ROOT] });
    fake.emitExit(0);
    const result = await runPromise;

    if (row.refusesUnexpressibleRoots) {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('invalid-state');
      expect(result.error.message).toContain(String(UNEXPRESSIBLE_ROOT));
      expect(fake.calls).toHaveLength(0);
      return;
    }
    expect(result.ok).toBe(true);
    if (row.grantsUnrestricted === true) {
      expect(fake.calls[0]!.args).not.toContain('--add-dir');
      return;
    }
    expect(row.grantedRoots(fake.calls[0]!)).toContain(String(UNEXPRESSIBLE_ROOT));
  });

  it('forwards effort if and only if PROVIDER_TRAITS says this surface forwards it', async () => {
    const { fake, runPromise } = await runSession({ effort: EFFORT });
    fake.emitExit(0);
    await runPromise;

    const call = fake.calls[0]!;
    const inArgv = call.args.join('\x00').includes(EFFORT);
    expect(inArgv).toBe(PROVIDER_TRAITS[row.provider].effortForwarding.interactive);
    // An adapter that "supports" effort by routing it through the environment would pass the argv
    // check while doing something the declaration does not describe.
    expect(Object.values(call.env ?? {}).join('\x00')).not.toContain(EFFORT);
  });

  it('leaves an omitted effort out of argv entirely', async () => {
    const { fake, runPromise } = await runSession();
    fake.emitExit(0);
    await runPromise;

    expect(fake.calls[0]!.args.join('\x00')).not.toContain(EFFORT);
  });

  it('propagates a caller abort as AbortError and reaches the child with SIGTERM', async () => {
    // AbortError is the one error chains propagate transparently — an adapter that reported the
    // resulting non-zero exit as a session error would let a downstream guard swallow the cancel.
    // The SIGTERM → grace → SIGKILL escalation itself lives in the shared engine and is asserted
    // once in `_engine/run-interactive-session.test.ts`.
    const controller = new AbortController();
    const { fake, runPromise } = await runSession({ abortSignal: controller.signal });
    controller.abort();
    fake.emitExit(143);
    const result = await runPromise;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('aborted');
    expect(fake.calls[0]!.kills).toEqual(['SIGTERM']);
  });
});

describe('InteractiveAiProvider conformance coverage', () => {
  it('has one row per provider in PROVIDER_TRAITS', () => {
    // The guard that makes this suite a gate rather than a snapshot: a fifth backend lands with a
    // row here, or it does not land.
    expect(ROWS.map((r) => r.provider).sort()).toEqual(Object.keys(PROVIDER_TRAITS).sort());
  });
});
