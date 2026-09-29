import { existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { FULL_AUTO } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { evaluatorOutputContract } from '@src/application/flows/implement/leaves/evaluator.contract.ts';
import { buildArm } from '../../../../scripts/eval/arms.ts';
import { createFakeProvider, type FakeProvider } from '../../../../scripts/eval/fake-provider.ts';
import { runEval } from '../../../../scripts/eval/run.ts';
import type { ResultsFile } from '../../../../scripts/eval/types.ts';
import { makeTmpRoot } from '../../../fixtures/tmp-root.ts';
import { writeMiniFixtures } from '../../../fixtures/eval-harness.ts';
import { evaluationSignals, makeEvalRunHarness } from '../../../fixtures/eval-run.ts';

let scratch: string;
let cleanup: () => Promise<void>;
let fixturesRoot: string;

beforeEach(async () => {
  const tmp = await makeTmpRoot();
  scratch = String(tmp.root);
  cleanup = tmp.cleanup;
  fixturesRoot = await writeMiniFixtures(join(scratch, 'fixtures'), ['evaluate']);
});
afterEach(async () => {
  await cleanup();
});

const PASS = evaluationSignals('passed');
const FAIL = evaluationSignals('failed', ['correctness']);
const readResults = async (runDir: string): Promise<ResultsFile> =>
  JSON.parse(await fs.readFile(join(runDir, 'results.json'), 'utf8')) as ResultsFile;

describe('runEval — evaluate flow through the real construction site', () => {
  it('measures what ships: the session, prompt and workspace match production', async () => {
    const seen: Array<{ oracleVisible: boolean; status: string }> = [];
    const git = createGitRunner();
    const provider = createFakeProvider({
      responses: [PASS, FAIL],
      beforeWrite: async (session: AiSession) => {
        const status = await git.run(session.cwd, ['status', '--porcelain']);
        seen.push({
          oracleVisible: existsSync(join(String(session.cwd), 'oracle')),
          status: status.ok ? status.value.stdout : 'git failed',
        });
      },
    });
    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider });

    const result = await runEval(h.deps, h.config);
    expect(result.ok).toBe(true);

    const session = provider.sessions[0] as AiSession;
    const outputDir = dirname(String(session.signalsFile));
    const root = dirname(String(session.cwd));
    expect(session.permissions).toBe(FULL_AUTO);
    expect(String(session.cwd)).toBe(join(root, 'repo'));
    expect(session.additionalRoots?.map(String)).toEqual([join(root, 'sandbox'), root]);
    expect(String(session.signalsFile)).toBe(join(root, 'sandbox', 'rounds', '1', 'evaluator', 'signals.json'));
    expect(session.role).toBe('evaluator');
    expect(session.model).toBe('claude-sonnet-5');
    expect(session.effort).toBe('high');
    expect(session.prompt).toContain(
      renderContractSectionFor(evaluatorOutputContract, AbsolutePath.parse(outputDir).value as AbsolutePath)
    );
    expect(session.prompt).toContain(join(root, 'sandbox', 'contract.md'));
    expect(session.prompt).toContain('Add an inc helper');

    // The hidden oracle is absent and the variant is an UNCOMMITTED change over the base commit.
    expect(seen.map((s) => s.oracleVisible)).toEqual([false, false]);
    expect(seen[0]?.status).toContain('?? src/inc.mjs');
  });

  it('grades both variants, writes every artifact, and cleans every workspace', async () => {
    const provider = createFakeProvider({ responses: [PASS, FAIL] });
    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider });
    const result = await runEval(h.deps, h.config);
    if (!result.ok) throw result.error;

    expect(result.value.stoppedReason).toBe('completed');
    expect(result.value.trials.map((t) => [t.variant, t.correct, t.graded, t.nudgeCount])).toEqual([
      ['clean', true, true, 0],
      ['defect', true, true, 0],
    ]);
    const stored = await readResults(h.runDir);
    expect(stored.schemaVersion).toBe(1);
    expect(stored.metrics.evaluate?.baseline?.find((m) => m.name === 'catch-rate')?.mean).toBe(1);
    expect(stored.metrics.evaluate?.baseline?.find((m) => m.name === 'false-fail-rate')?.mean).toBe(0);
    expect(await fs.readFile(join(h.runDir, 'summary.md'), 'utf8')).toContain('## evaluate');
    const ndjson = (await fs.readFile(join(h.runDir, 'trials.ndjson'), 'utf8')).trim().split('\n');
    expect(ndjson).toHaveLength(2);
    const dir = join(h.runDir, 'trials', 'mini-ev', 'defect', 'baseline', '1');
    expect(existsSync(join(dir, 'prompt.md'))).toBe(true);
    expect(existsSync(join(dir, 'signals.json'))).toBe(true);
    expect(JSON.parse(await fs.readFile(join(dir, 'grade.json'), 'utf8'))).toMatchObject({
      flow: 'evaluate',
      correct: true,
    });
    expect(await fs.readdir(h.workspaceRoot)).toEqual([]);
  });

  it('records a wrong verdict as incorrect, not as an error', async () => {
    const provider = createFakeProvider({ responses: [FAIL, PASS] }); // false FAIL on clean, false PASS on defect
    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider });
    const result = await runEval(h.deps, h.config);
    if (!result.ok) throw result.error;
    expect(result.value.trials.map((t) => t.correct)).toEqual([false, false]);
    const rows = result.value.metrics.evaluate?.baseline ?? [];
    expect(rows.find((m) => m.name === 'false-fail-rate')?.mean).toBe(1);
    expect(rows.find((m) => m.name === 'false-pass-rate')?.mean).toBe(1);
    expect(await fs.readFile(join(h.runDir, 'summary.md'), 'utf8')).toContain('## Trials to read');
  });

  it('nudges a missing signals.json on the resumed session and sums the nudge tokens', async () => {
    const provider = createFakeProvider({ responses: ['missing', PASS, FAIL], sessionId: 'sess-7' });
    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider });
    const result = await runEval(h.deps, h.config);
    if (!result.ok) throw result.error;
    const [clean, defect] = result.value.trials;
    expect(clean).toMatchObject({ correct: true, nudgeCount: 1, structurallyValid: true });
    expect(clean?.usage).toMatchObject({ inputTokens: 2000, outputTokens: 400, metered: true });
    expect(defect?.nudgeCount).toBe(0);
    const nudge = provider.sessions[1] as AiSession;
    expect(nudge.resume).toBe('sess-7');
    expect(nudge.prompt).toContain('did not satisfy the output contract');
    expect(String(nudge.bodyFile)).toContain('body-corrective-1.txt');
    const rows = result.value.metrics.evaluate?.baseline ?? [];
    expect(rows.find((m) => m.name === 'structural-valid-first-try')?.mean).toBe(0.5);
    expect(rows.find((m) => m.name === 'structural-valid-after-nudges')?.mean).toBe(1);
  });

  it('grades an unrecoverable contract failure as incorrect and structurally invalid', async () => {
    const provider = createFakeProvider({ responses: ['garbage'] });
    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider });
    const result = await runEval(h.deps, h.config);
    if (!result.ok) throw result.error;
    expect(result.value.trials[0]).toMatchObject({
      graded: true,
      correct: false,
      structurallyValid: false,
      nudgeCount: 2,
    });
    expect(provider.sessions).toHaveLength(6); // 2 trials × (1 spawn + 2 nudges)
  });

  it('stops on the token budget, keeps the partial results and marks unreached items incomplete', async () => {
    const provider = createFakeProvider({ responses: [PASS, FAIL] });
    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider, maxTokens: 1500 });
    const result = await runEval(h.deps, h.config);
    if (!result.ok) throw result.error;
    expect(result.value.stoppedReason).toBe('budget');
    expect(result.value.trials).toHaveLength(1);
    expect(result.value.incompleteItems).toEqual(['baseline:mini-ev/defect']);
    expect(result.value.budget).toMatchObject({ inputTokens: 1000, outputTokens: 200, maxTokens: 1500 });
    expect((await readResults(h.runDir)).stoppedReason).toBe('budget');
  });

  it('fails closed on an unmetered provider unless told otherwise', async () => {
    const failClosed = createFakeProvider({ responses: [PASS, FAIL], usage: null });
    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider: failClosed });
    const stopped = await runEval(h.deps, h.config);
    if (!stopped.ok) throw stopped.error;
    expect(stopped.value.stoppedReason).toBe('unmetered');
    expect(stopped.value.trials).toHaveLength(1);
    expect(stopped.value.trials[0]?.usage).toMatchObject({ inputTokens: null, outputTokens: null, metered: false });
    expect(stopped.value.usage.evaluate?.baseline).toMatchObject({ inputTokens: null, unmeteredTrials: 1 });

    const permissive = createFakeProvider({ responses: [PASS, FAIL], usage: null });
    const h2 = await makeEvalRunHarness({
      fixturesRoot,
      scratch: join(scratch, 'second'),
      provider: permissive,
      allowUnmetered: true,
    });
    const completed = await runEval(h2.deps, h2.config);
    if (!completed.ok) throw completed.error;
    expect(completed.value.stoppedReason).toBe('completed');
    expect(completed.value.budget.unmeteredTrials).toBe(2);
  });

  it('propagates AbortError after flushing the partial results', async () => {
    const aborting = { generate: async () => Result.error(new AbortError({ elementName: 'test' })) };
    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider: aborting });
    const result = await runEval(h.deps, h.config);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AbortError);
    expect((await readResults(h.runDir)).stoppedReason).toBe('aborted');
    expect(await fs.readdir(h.workspaceRoot)).toEqual([]);
  });

  it('propagates an abort raised by the corrective respawn too', async () => {
    let calls = 0;
    const base: FakeProvider = createFakeProvider({ responses: ['missing'] });
    const provider = {
      generate: async (session: AiSession) => {
        calls += 1;
        return calls === 1 ? base.generate(session) : Result.error(new AbortError({ elementName: 'nudge' }));
      },
    };
    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider });
    const result = await runEval(h.deps, h.config);
    expect(!result.ok && result.error instanceof AbortError).toBe(true);
  });

  it('honours an already-aborted signal without spawning anything', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createFakeProvider({ responses: [PASS] });
    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider, signal: controller.signal });
    const result = await runEval(h.deps, h.config);
    expect(!result.ok && result.error instanceof AbortError).toBe(true);
    expect(provider.sessions).toHaveLength(0);
    expect((await readResults(h.runDir)).stoppedReason).toBe('aborted');
  });

  it('records a spawn failure as an ungraded trial and stops after repeated infrastructure errors', async () => {
    const broken = {
      generate: async () =>
        Result.error(new InvalidStateError({ entity: 'x', currentState: 'y', attemptedAction: 'z' })),
    };
    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider: broken, k: 3 });
    const result = await runEval(h.deps, h.config);
    if (!result.ok) throw result.error;
    expect(result.value.stoppedReason).toBe('errors');
    expect(result.value.trials).toHaveLength(3);
    expect(result.value.trials.every((t) => !t.graded && t.error !== undefined)).toBe(true);
    expect(result.value.metrics).toEqual({});
    expect(result.value.incompleteItems).toEqual(['baseline:mini-ev/clean', 'baseline:mini-ev/defect']);
  });

  it('refuses to spend anything when a fixture label is not proven', async () => {
    const provider = createFakeProvider({ responses: [PASS] });
    const h = await makeEvalRunHarness({
      fixturesRoot,
      scratch,
      provider,
      preflight: async () =>
        Result.ok([
          {
            fixtureId: 'mini-ev',
            flow: 'evaluate' as const,
            ok: false,
            lines: ['FAIL variant defect: oracle passed, expected fail'],
          },
        ]),
    });
    const result = await runEval(h.deps, h.config);
    expect(!result.ok && result.error.message).toContain('fixture labels not proven');
    expect(provider.sessions).toHaveLength(0);
  });

  it('interleaves two arms per trial, alternating which goes first per item, and pairs the results', async () => {
    const provider = createFakeProvider({ responses: [PASS, PASS, FAIL, FAIL] });
    const baseline = buildArm({ name: 'baseline' });
    const candidate = buildArm({ name: 'candidate', model: 'claude-opus-5-5' });
    if (!baseline.ok || !candidate.ok) throw new Error('arm');
    const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider, arms: [baseline.value, candidate.value] });
    const result = await runEval(h.deps, h.config);
    if (!result.ok) throw result.error;
    // item 0 (clean): baseline, candidate — item 1 (defect): candidate, baseline
    expect(provider.sessions.map((s) => s.model)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5',
    ]);
    expect(result.value.trials.map((t) => t.arm)).toEqual(['baseline', 'candidate', 'candidate', 'baseline']);
    expect(result.value.arms.map((a) => a.name)).toEqual(['baseline', 'candidate']);
    // one item per arm pair is too few to pair (n < 2 shared items would need 2+): both items ARE shared here
    expect(result.value.comparison).toBeDefined();
  });
});
