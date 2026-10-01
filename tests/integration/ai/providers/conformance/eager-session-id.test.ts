import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { makeProviderSpawn } from '@tests/fixtures/provider-spawn-fake.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { CodexProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { ChildRegistry, RegisteredChild } from '@src/integration/ai/providers/_engine/child-registry.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';
import { FULL_AUTO } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import { createCodexProvider } from '@src/integration/ai/providers/codex/headless.ts';
import { createCopilotProvider } from '@src/integration/ai/providers/copilot/headless.ts';
import { createOpencodeProvider } from '@src/integration/ai/providers/opencode/headless.ts';

/**
 * The session id lands on disk (`session-id.txt`) and in the live-run record the moment the stream
 * yields it — while the child is still running — so a harness killed mid-spawn leaves a resumable
 * thread behind. Each row's child prints its id line and then hangs; the assertions run before the
 * spawn ever exits. Grok is absent on purpose: its stream reports the id only on the final `end`
 * record, so there is nothing to capture early.
 */

const SID = 'eager-sid-1';

interface EagerRow {
  readonly provider: AiProvider;
  readonly create: (deps: CodexProviderDeps) => HeadlessAiProvider;
  readonly idLine: string;
}

const ROWS: readonly EagerRow[] = [
  {
    provider: 'claude-code',
    create: createClaudeProvider,
    idLine: `{"type":"system","subtype":"init","session_id":"${SID}"}\n`,
  },
  { provider: 'openai-codex', create: createCodexProvider, idLine: `{"type":"thread.started","thread_id":"${SID}"}\n` },
  { provider: 'github-copilot', create: createCopilotProvider, idLine: `{"session_id":"${SID}","model":"m"}\n` },
  {
    provider: 'opencode',
    create: createOpencodeProvider,
    idLine: `{"type":"step_start","timestamp":1,"sessionID":"${SID}","part":{"type":"step-start"}}\n`,
  },
];

describe.each(ROWS)('eager session-id persistence — $provider', (row) => {
  let tmp: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    tmp = await makeTmpRoot();
    await mkdir(join(String(tmp.root), 'out'), { recursive: true });
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('writes session-id.txt and notes the run record while the child is still running', async () => {
    const cap = createCapturingBus();
    const fake = makeProviderSpawn([{ stdoutChunks: [row.idLine], hang: true }]);
    // The scripted child reports pid 0, which the registry skips; give it a fake one.
    const spawn: ProviderSpawn = (command, args, options) => {
      const child = fake.spawn(command, args, options);
      Object.defineProperty(child, 'pid', { value: 4242 });
      return child;
    };
    const noted: string[] = [];
    const registered: RegisteredChild[] = [];
    const childRegistry: ChildRegistry = {
      register: (child) => {
        registered.push(child);
        return { noteSessionId: (id) => noted.push(id), release: () => {} };
      },
    };
    const provider = row.create({
      rateLimitRetries: 0,
      backoffSchedule: [0],
      eventBus: cap.bus,
      spawn,
      childRegistry,
      mkTempPath: () => join(String(tmp.root), 'codex-body.txt'),
      readFile: () => Promise.resolve(''),
      unlink: () => Promise.resolve(),
    });
    const signalsFile = join(String(tmp.root), 'out', 'signals.json');
    const sidFile = join(String(tmp.root), 'out', 'session-id.txt');
    const abort = new AbortController();

    const pending = provider.generate({
      prompt: 'p',
      cwd: absolutePath('/tmp/eager-sid-cwd'),
      outputDir: absolutePath(join(String(tmp.root), 'out')),
      signalsFile: absolutePath(signalsFile),
      model: PROVIDER_TRAITS[row.provider].modelCatalog[0]!,
      permissions: FULL_AUTO,
      abortSignal: abort.signal,
    });

    await vi.waitFor(() => {
      expect(existsSync(sidFile)).toBe(true);
    });
    expect(readFileSync(sidFile, 'utf8')).toBe(`${SID}\n`);
    expect(noted).toEqual([SID]);
    expect(registered).toHaveLength(1);
    // Still running: nothing has asked the child to stop yet.
    expect(fake.calls[0]!.kills).toEqual([]);

    abort.abort();
    await pending;
  });
});
