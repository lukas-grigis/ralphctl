import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { makeProviderSpawn, type ProviderSpawnCall } from '@tests/fixtures/provider-spawn-fake.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { CodexProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { SpawnScript } from '@src/integration/ai/providers/_engine/scripted-spawn.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';
import { FULL_AUTO } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import { createCodexProvider } from '@src/integration/ai/providers/codex/headless.ts';
import { createCopilotProvider } from '@src/integration/ai/providers/copilot/headless.ts';
import { createOpencodeProvider } from '@src/integration/ai/providers/opencode/headless.ts';
import { createGrokProvider } from '@src/integration/ai/providers/grok/headless.ts';

/**
 * Stale-resume cold fallback carries the FULL prompt, per adapter.
 *
 * A `--resume` whose thread the provider no longer has fails; the shared retry loop respawns cold.
 * The resumed spawn was given a slim continuation prompt (it presumes the conversation holds the
 * brief), so the cold respawn must be handed `session.coldPrompt` — the full first-attempt prompt —
 * or it starts with no task brief at all. Each row scripts the adapter's own stale wording (the
 * `RESUME_STALE_RE` it registered) and asserts, from the spawn record alone, which prompt each
 * spawn received and whether argv carried the resume flag.
 */

const CONTINUATION = 'SLIM-CONTINUATION-PROMPT';
const FULL = 'FULL-FIRST-ATTEMPT-PROMPT';
const RESUME_ID = 'gone-id';

interface StaleRow {
  readonly provider: AiProvider;
  readonly create: (deps: CodexProviderDeps) => HeadlessAiProvider;
  readonly model: string;
  /** The adapter's own wording for a resume id the provider no longer has. */
  readonly stale: SpawnScript;
  readonly hasResume: (args: readonly string[]) => boolean;
  /** Prompt delivery: stdin, or a file the adapter names in argv. */
  readonly promptFileName?: string;
}

const ROWS: readonly StaleRow[] = [
  {
    provider: 'claude-code',
    create: createClaudeProvider,
    model: PROVIDER_TRAITS['claude-code'].modelCatalog[0]!,
    stale: { stderrChunks: [`No conversation found with session ID: ${RESUME_ID}\n`], exitCode: 1 },
    hasResume: (args) => args.includes('--resume'),
  },
  {
    provider: 'openai-codex',
    create: createCodexProvider,
    model: PROVIDER_TRAITS['openai-codex'].modelCatalog[0]!,
    stale: {
      stderrChunks: [`Error: thread/resume failed: no rollout found for thread id ${RESUME_ID} (code -32600)\n`],
      exitCode: 1,
    },
    hasResume: (args) => args.includes('resume'),
  },
  {
    provider: 'github-copilot',
    create: createCopilotProvider,
    model: PROVIDER_TRAITS['github-copilot'].modelCatalog[0]!,
    stale: { stderrChunks: [`Error: session ${RESUME_ID} not found\n`], exitCode: 1 },
    hasResume: (args) => args.some((a) => a.startsWith('--resume')),
    promptFileName: 'copilot-prompt.md',
  },
  {
    provider: 'opencode',
    create: createOpencodeProvider,
    model: PROVIDER_TRAITS.opencode.modelCatalog[0]!,
    stale: { stderrChunks: ['Error: Session not found\n'], exitCode: 1 },
    hasResume: (args) => args.includes('-s'),
  },
  {
    provider: 'xai-grok',
    create: createGrokProvider,
    model: PROVIDER_TRAITS['xai-grok'].modelCatalog[0]!,
    stale: {
      stdoutChunks: [`{"type":"error","message":"Session \\"${RESUME_ID}\\" not found locally"}\n`],
      exitCode: 1,
    },
    hasResume: (args) => args.includes('-r'),
    promptFileName: 'grok-prompt.md',
  },
];

describe.each(ROWS)('stale-resume cold fallback prompt — $provider', (row) => {
  let tmp: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    tmp = await makeTmpRoot();
    await mkdir(join(String(tmp.root), 'out'), { recursive: true });
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  const session = (overrides: Partial<AiSession> = {}): AiSession => ({
    prompt: CONTINUATION,
    cwd: absolutePath('/tmp/stale-resume-cwd'),
    outputDir: absolutePath(join(String(tmp.root), 'out')),
    signalsFile: absolutePath(join(String(tmp.root), 'out', 'signals.json')),
    model: row.model,
    permissions: FULL_AUTO,
    resume: RESUME_ID as SessionId,
    ...overrides,
  });

  /** Runs one stale → success arc; returns each spawn's prompt as the CLI received it. */
  const run = async (overrides: Partial<AiSession>) => {
    const cap = createCapturingBus();
    const promptFile = row.promptFileName !== undefined ? join(String(tmp.root), 'out', row.promptFileName) : undefined;
    // The prompt file is rewritten by the second spawn, so snapshot it at spawn time.
    const filePrompts: string[] = [];
    const fake = makeProviderSpawn(() => {
      filePrompts.push(promptFile !== undefined && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '');
      return filePrompts.length === 1 ? row.stale : { exitCode: 0 };
    });
    const provider = row.create({
      rateLimitRetries: 0,
      backoffSchedule: [0],
      eventBus: cap.bus,
      spawn: fake.spawn,
      mkTempPath: () => join(String(tmp.root), 'codex-body.txt'),
      readFile: () => Promise.resolve(''),
      unlink: () => Promise.resolve(),
    });
    const out = await provider.generate(session(overrides));
    const received = (call: ProviderSpawnCall, i: number): string =>
      row.promptFileName !== undefined ? (filePrompts[i] ?? '') : call.stdin;
    return { out, calls: fake.calls, prompts: fake.calls.map(received) };
  };

  it('resumes with the continuation prompt, then respawns cold with the full coldPrompt', async () => {
    const { out, calls, prompts } = await run({ coldPrompt: FULL });

    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(row.hasResume(calls[0]!.args)).toBe(true);
    expect(prompts[0]).toContain(CONTINUATION);
    expect(prompts[0]).not.toContain(FULL);
    expect(row.hasResume(calls[1]!.args)).toBe(false);
    expect(prompts[1]).toContain(FULL);
    expect(prompts[1]).not.toContain(CONTINUATION);
  });

  it('keeps the same prompt on the cold respawn when no coldPrompt was supplied', async () => {
    const { out, calls, prompts } = await run({});

    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(row.hasResume(calls[1]!.args)).toBe(false);
    expect(prompts[1]).toContain(CONTINUATION);
  });
});
