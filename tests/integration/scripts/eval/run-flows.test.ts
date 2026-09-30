import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FULL_AUTO, READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import { createFakeProvider } from '../../../../scripts/eval/fake-provider.ts';
import { runEval } from '../../../../scripts/eval/run.ts';
import { applyPatchFile } from '../../../../scripts/eval/workspace.ts';
import type { ImplementGrade, ResultsFile, TrialRecord } from '../../../../scripts/eval/types.ts';
import { makeTmpRoot } from '../../../fixtures/tmp-root.ts';
import { writeMiniFixtures } from '../../../fixtures/eval-harness.ts';
import { makeEvalRunHarness } from '../../../fixtures/eval-run.ts';

let scratch: string;
let cleanup: () => Promise<void>;
let fixturesRoot: string;

beforeEach(async () => {
  const tmp = await makeTmpRoot();
  scratch = String(tmp.root);
  cleanup = tmp.cleanup;
  fixturesRoot = await writeMiniFixtures(join(scratch, 'fixtures'));
});
afterEach(async () => {
  await cleanup();
});

const run = async (
  idGlob: string,
  provider: Parameters<typeof makeEvalRunHarness>[0]['provider']
): Promise<{ results: ResultsFile; runDir: string }> => {
  const h = await makeEvalRunHarness({ fixturesRoot, scratch, provider, idGlob });
  const result = await runEval(h.deps, h.config);
  if (!result.ok) throw result.error;
  return { results: result.value, runDir: h.runDir };
};

const only = (results: ResultsFile): TrialRecord => {
  expect(results.trials).toHaveLength(1);
  return results.trials[0] as TrialRecord;
};

const DONE = [{ type: 'task-verified', output: 'ran the tests' }, { type: 'task-complete' }];

describe('implement flow', () => {
  const applyReference = async (session: AiSession): Promise<void> => {
    await applyPatchFile(
      createGitRunner(),
      session.cwd,
      join(fixturesRoot, 'implement', 'mini-im', 'variants', 'reference.patch')
    );
  };

  it('grades by the hidden oracle: a real fix is correct, in a FULL_AUTO generator session', async () => {
    const provider = createFakeProvider({ responses: [DONE], beforeWrite: applyReference });
    const { results, runDir } = await run('mini-im', provider);
    const t = only(results);
    expect(t).toMatchObject({ correct: true, structurallyValid: true, graded: true });
    expect(t.grade).toMatchObject({ flow: 'implement', oraclePassed: true, falseCompletion: false });
    const session = provider.sessions[0] as AiSession;
    expect(session.permissions).toBe(FULL_AUTO);
    expect(session.role).toBe('generator');
    expect(session.model).toBe('claude-sonnet-5-5');
    expect(session.prompt).toContain('Add an inc helper');
    expect(session.prompt).toContain('signals.json');
    expect(
      await fs.readFile(join(runDir, 'trials', 'mini-im', 'default', 'baseline', '1', 'oracle.txt'), 'utf8')
    ).toContain('pass');
  });

  it('flags a false completion: claimed done, nothing fixed', async () => {
    const { results } = await run('mini-im', createFakeProvider({ responses: [DONE] }));
    expect(only(results)).toMatchObject({ correct: false, structurallyValid: true });
    expect(only(results).grade).toMatchObject({ oraclePassed: false, falseCompletion: true });
    expect(results.metrics.implement?.baseline?.find((m) => m.name === 'false-completion')?.mean).toBe(1);
  });

  it('treats editing a protected path as a bypass even when the model claims success', async () => {
    const specPath = join(fixturesRoot, 'implement', 'mini-im', 'fixture.json');
    const spec = JSON.parse(await fs.readFile(specPath, 'utf8')) as { oracle: Record<string, unknown> };
    await fs.writeFile(
      specPath,
      JSON.stringify({ ...spec, oracle: { ...spec.oracle, protectedPaths: ['src/inc.mjs'] } })
    );
    const { results } = await run('mini-im', createFakeProvider({ responses: [DONE], beforeWrite: applyReference }));
    const grade = only(results).grade as ImplementGrade;
    expect(grade.protectedPathsTouched).toEqual(['src/inc.mjs']);
    expect(only(results).correct).toBe(false);
  });
});

describe('detect-scripts flow', () => {
  const proposal = (command: string) => [[{ type: 'verify-script', command }]];

  it('is correct when the proposed script passes clean and fails broken, in a READ_ONLY session', async () => {
    const provider = createFakeProvider({ responses: proposal('node --test test/*.test.mjs') });
    const { results } = await run('mini-ds', provider);
    expect(only(results).grade).toMatchObject({
      flow: 'detect-scripts',
      cleanPasses: true,
      brokenFails: true,
      exactMatch: true,
    });
    expect(only(results).correct).toBe(true);
    const session = provider.sessions[0] as AiSession;
    expect(session.permissions).toBe(READ_ONLY);
    expect(String(session.cwd)).toMatch(/\/repo$/);
    expect(session.prompt).toContain(String(session.cwd));
  });

  it('accepts a different script that behaves correctly (outcome, not string match)', async () => {
    const { results } = await run('mini-ds', createFakeProvider({ responses: proposal('npm test') }));
    expect(only(results).grade).toMatchObject({ correct: true, exactMatch: false });
  });

  it('rejects a vacuous gate that also passes on the broken repo', async () => {
    const { results } = await run('mini-ds', createFakeProvider({ responses: proposal('true') }));
    expect(only(results).grade).toMatchObject({ cleanPasses: true, brokenFails: false, correct: false });
  });

  it('rejects a script that is red on the clean repo', async () => {
    const { results } = await run('mini-ds', createFakeProvider({ responses: proposal('false') }));
    expect(only(results).grade).toMatchObject({ cleanPasses: false, brokenFails: true, correct: false });
  });

  it('does not nudge: production validates once, so a missing file is invalid after exactly one spawn', async () => {
    const provider = createFakeProvider({ responses: ['missing', ...proposal('node --test test/*.test.mjs')] });
    const { results } = await run('mini-ds', provider);
    expect(provider.sessions).toHaveLength(1);
    expect(only(results)).toMatchObject({ structurallyValid: false, correct: false, nudgeCount: 0 });
  });

  it('is incorrect when nothing is proposed', async () => {
    const { results } = await run('mini-ds', createFakeProvider({ responses: [[]] }));
    expect(only(results)).toMatchObject({ correct: false });
    expect(only(results).grade).toMatchObject({ proposed: null });
  });
});

describe('select-candidate flow', () => {
  const verdict = (winner: number) => [{ type: 'candidate-selection', winner, rationale: 'picked from the summaries' }];

  it('runs every item in BOTH candidate orders and maps the slot back to a candidate', async () => {
    const provider = createFakeProvider({ responses: [verdict(1), verdict(2)] }); // ab → slot 1 = a; ba → slot 2 = a
    const { results } = await run('mini-sc', provider);
    expect(results.trials.map((t) => [t.variant, t.correct])).toEqual([
      ['ab', true],
      ['ba', true],
    ]);
    const [ab, ba] = provider.sessions as [AiSession, AiSession];
    const at = (s: AiSession, text: string): number => s.prompt.indexOf(text);
    expect(ab.permissions).toBe(READ_ONLY);
    expect(at(ab, 'Verify outcome: success')).toBeLessThan(at(ab, 'Verify outcome: failed'));
    expect(at(ba, 'Verify outcome: failed')).toBeLessThan(at(ba, 'Verify outcome: success'));
    expect(results.metrics['select-candidate']?.baseline?.find((m) => m.name === 'order-agreement')?.mean).toBe(1);
  });

  it('exposes a position-biased judge: always picking slot 1 scores 50% and never agrees with itself', async () => {
    const { results } = await run('mini-sc', createFakeProvider({ responses: [verdict(1)] }));
    expect(results.trials.map((t) => t.correct)).toEqual([true, false]);
    const rows = results.metrics['select-candidate']?.baseline ?? [];
    expect(rows.find((m) => m.name === 'correct')?.mean).toBe(0.5);
    expect(rows.find((m) => m.name === 'order-agreement')?.mean).toBe(0);
  });

  it('does not nudge: production falls back on an invalid verdict, so each item is one spawn', async () => {
    const provider = createFakeProvider({ responses: ['missing', verdict(1)] });
    const { results } = await run('mini-sc', provider);
    expect(provider.sessions).toHaveLength(2); // one per order, no resumed respawn
    expect(results.trials[0]).toMatchObject({ structurallyValid: false, correct: false, nudgeCount: 0 });
  });

  it('counts a tie (winner 0) as incorrect', async () => {
    const { results } = await run('mini-sc', createFakeProvider({ responses: [verdict(0)] }));
    expect(
      results.trials.every((t) => !t.correct && t.grade?.flow === 'select-candidate' && t.grade.picked === 'tie')
    ).toBe(true);
  });
});
