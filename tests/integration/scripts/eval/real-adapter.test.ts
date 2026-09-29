import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { AiFlowSettings } from '@src/domain/entity/settings.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { runEval } from '../../../../scripts/eval/run.ts';
import { makeTmpRoot } from '../../../fixtures/tmp-root.ts';
import { makeProviderSpawn } from '../../../fixtures/provider-spawn-fake.ts';
import { writeMiniFixtures } from '../../../fixtures/eval-harness.ts';
import { evaluationSignals, makeEvalRunHarness } from '../../../fixtures/eval-run.ts';

/**
 * Wiring fence: the harness's session, built by the shipped builders, must be accepted by the REAL
 * Claude adapter (model validation, permission mapping, `--add-dir` roots, prompt on stdin). Only
 * the child process is fake — the scripted child writes `signals.json` the way the AI's Write tool
 * would, so a session the adapter refuses fails here instead of on the first paid trial.
 */

let scratch: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const tmp = await makeTmpRoot();
  scratch = String(tmp.root);
  cleanup = tmp.cleanup;
});
afterEach(async () => {
  await cleanup();
});

describe('the real claude adapter behind the eval harness', () => {
  it('accepts an evaluate session and produces a graded trial', async () => {
    const fixturesRoot = await writeMiniFixtures(join(scratch, 'fixtures'), ['evaluate']);
    let pending: AiSession | undefined;
    const answers = [evaluationSignals('passed'), evaluationSignals('failed', ['correctness'])];
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 'sess-1',
      usage: { input_tokens: 111, output_tokens: 22 },
    });
    const spawn = makeProviderSpawn((choice) => {
      const session = pending as AiSession;
      mkdirSync(dirname(String(session.signalsFile)), { recursive: true });
      const signals = (answers[choice.index] ?? []).map((s) => ({ timestamp: '2026-01-01T00:00:00.000Z', ...s }));
      writeFileSync(String(session.signalsFile), JSON.stringify({ schemaVersion: 1, signals }));
      return { stdoutChunks: [`${init}\n${result}\n`], exitCode: 0 };
    });

    const bus = createInMemoryEventBus();
    const real = (row: unknown): HeadlessAiProvider =>
      createAiProvider({
        row: row as AiFlowSettings,
        harnessConfig: DEFAULT_SETTINGS.harness,
        eventBus: bus,
        spawn: spawn.spawn,
      });
    const provider: HeadlessAiProvider = {
      generate: async (session) => {
        pending = session;
        return real({ provider: 'claude-code', model: 'claude-sonnet-5' }).generate(session);
      },
    };

    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider });
    const ran = await runEval(h.deps, h.config);
    if (!ran.ok) throw ran.error;

    expect(ran.value.trials.map((t) => [t.variant, t.graded, t.correct, t.structurallyValid])).toEqual([
      ['clean', true, true, true],
      ['defect', true, true, true],
    ]);
    expect(ran.value.trials[0]?.usage).toMatchObject({ inputTokens: 111, outputTokens: 22, metered: true });

    const call = spawn.calls[0];
    const args = call?.args ?? [];
    const valueOf = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(valueOf('--model')).toBe('claude-sonnet-5');
    expect(valueOf('--effort')).toBe('high');
    expect(call?.cwd).toMatch(/\/repo$/);
    const roots = args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1] as string] : []));
    expect(roots.some((r) => r.endsWith('/sandbox'))).toBe(true);
    expect(roots.some((r) => r.endsWith('/sandbox/rounds/1/evaluator'))).toBe(true);
    expect(call?.stdin).toContain('Add an inc helper');
  });
});
