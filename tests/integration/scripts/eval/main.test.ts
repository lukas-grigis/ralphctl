import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { main } from '../../../../scripts/eval/main.ts';
import type { ResultsFile } from '../../../../scripts/eval/types.ts';
import { makeTmpRoot } from '../../../fixtures/tmp-root.ts';
import { writeMiniFixtures } from '../../../fixtures/eval-harness.ts';

/**
 * The real composition root (`main`): argv → real arms, template loader, git / shell runners and
 * results store. Only the provider is fake (`--dry-run`), so a stray construction gap in `main.ts`
 * that unit tests injecting the dependency would miss shows up here.
 */

let scratch: string;
let cleanup: () => Promise<void>;
let fixtures: string;
let out: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  const tmp = await makeTmpRoot();
  scratch = String(tmp.root);
  cleanup = tmp.cleanup;
  fixtures = await writeMiniFixtures(join(scratch, 'fixtures'));
  out = join(scratch, 'results');
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void stdout.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void stderr.push(a.join(' ')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

const base = (...extra: string[]): string[] => ['--fixtures-dir', fixtures, '--results-dir', out, ...extra];
const lastRun = async (): Promise<{ dir: string; results: ResultsFile }> => {
  const [name] = await fs.readdir(out);
  const dir = join(out, name as string);
  return { dir, results: JSON.parse(await fs.readFile(join(dir, 'results.json'), 'utf8')) as ResultsFile };
};

describe('pnpm eval check', () => {
  it('proves every fixture and exits 0', async () => {
    expect(await main(['check', ...base()])).toBe(0);
    expect(stdout.join('\n')).toContain('4/4 fixtures proven');
  });

  it('exits 1 and names the fixture when a label is not proven', async () => {
    const dir = join(fixtures, 'evaluate', 'mini-ev', 'variants');
    await fs.copyFile(join(dir, 'clean.patch'), join(dir, 'defect.patch'));
    expect(await main(['check', ...base()])).toBe(1);
    expect(stdout.join('\n')).toContain('FAIL evaluate/mini-ev');
    expect(stdout.join('\n')).toContain('1 rejected');
  });
});

describe('pnpm eval run --dry-run', () => {
  it('runs every flow end to end against a scripted provider and writes the results', async () => {
    expect(await main(['run', '--dry-run', '--max-tokens', '100000', '-k', '1', ...base()])).toBe(0);
    const { dir, results } = await lastRun();
    expect(results.dryRun).toBe(true);
    expect(results.k).toBe(1);
    // evaluate 2 items + implement 1 + detect 1 + select 1 (two orders) → k=1 trial each
    expect(results.trials).toHaveLength(2 + 1 + 1 + 2);
    expect(results.trials.every((t) => t.graded && t.correct)).toBe(true);
    expect(Object.keys(results.metrics).sort()).toEqual([
      'detect-scripts',
      'evaluate',
      'implement',
      'select-candidate',
    ]);
    expect(results.arms[0]).toMatchObject({ name: 'baseline', label: 'claude-economic' });
    expect(results.arms[0]?.templatesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.readFile(join(dir, 'summary.md'), 'utf8')).toContain('DRY RUN');
  });

  it('is fail-closed on the budget: --max-tokens is required and small budgets stop the run with exit 2', async () => {
    expect(await main(['run', '--dry-run', ...base()])).toBe(1);
    expect(stderr.join('\n')).toContain('--max-tokens is required');
    expect(await main(['run', '--dry-run', '--max-tokens', '1500', '-k', '1', ...base()])).toBe(2);
    const { results } = await lastRun();
    expect(results.stoppedReason).toBe('budget');
    expect(results.incompleteItems.length).toBeGreaterThan(0);
  });

  it('refuses to run when a fixture label is not proven', async () => {
    const dir = join(fixtures, 'implement', 'mini-im', 'variants');
    await fs.writeFile(join(dir, 'reference.patch'), '');
    expect(await main(['run', '--dry-run', '--max-tokens', '100000', '-k', '1', ...base()])).toBe(1);
    expect(stderr.join('\n')).toContain('fixture labels not proven');
    await expect(fs.readdir(out)).rejects.toThrow();
  });

  it('exits 1 when no fixture matches the filters', async () => {
    expect(await main(['run', '--dry-run', '--max-tokens', '1000', ...base('--fixture', 'nope-*')])).toBe(1);
    expect(stderr.join('\n')).toContain('no fixtures matched');
  });
});

describe('pnpm eval compare / report', () => {
  it('compares two arms and writes a paired comparison', async () => {
    expect(
      await main([
        'compare',
        '--dry-run',
        '--max-tokens',
        '500000',
        '-k',
        '2',
        '--flow',
        'evaluate',
        '--candidate-model',
        'claude-opus-5-5',
        ...base(),
      ])
    ).toBe(0);
    const { results } = await lastRun();
    expect(results.arms.map((a) => a.name)).toEqual(['baseline', 'candidate']);
    expect(results.arms[1]?.rows.evaluate.model).toBe('claude-opus-5-5');
    expect(results.comparison?.length).toBeGreaterThan(0);
    expect(results.comparison?.some((c) => c.metric === 'correct')).toBe(true);
  });

  it('compares candidate templates: the candidate arm carries its own directory and hash', async () => {
    const templates = join(scratch, 'templates');
    await fs.mkdir(join(templates, 'evaluate'), { recursive: true });
    await fs.writeFile(join(templates, 'evaluate', 'template.md'), 'x');
    expect(
      await main([
        'compare',
        '--dry-run',
        '--max-tokens',
        '500000',
        '-k',
        '1',
        '--flow',
        'detect-scripts',
        '--candidate-templates',
        templates,
        ...base(),
      ])
    ).toBe(0);
    const { results } = await lastRun();
    expect(results.arms[1]?.templatesDir).toBe(templates);
    expect(results.arms[1]?.templatesHash).not.toBe(results.arms[0]?.templatesHash);
  });

  it('refuses a --candidate-templates compare that reads the same prompts as the baseline (an A/A run)', async () => {
    expect(
      await main([
        'compare',
        '--dry-run',
        '--max-tokens',
        '500000',
        '--flow',
        'detect-scripts',
        '--candidate-templates',
        String(defaultTemplatesDir()),
        ...base(),
      ])
    ).toBe(1);
    expect(stderr.join('\n')).toContain('same prompt templates');
    await expect(fs.readdir(out)).rejects.toThrow();
  });

  it('reports offline on two results files without spending anything', async () => {
    expect(await main(['run', '--dry-run', '--max-tokens', '100000', '-k', '2', '--flow', 'evaluate', ...base()])).toBe(
      0
    );
    const first = join((await lastRun()).dir, 'results.json');
    const second = join(scratch, 'second.json');
    await fs.copyFile(first, second);
    stdout.length = 0;
    expect(await main(['report', first, second])).toBe(0);
    const text = stdout.join('\n');
    expect(text).toContain('## Comparison');
    expect(text).toContain('no detectable difference at this N');
  });

  it('reports each results file under its own arm: the candidate keeps its own metrics, not the baseline label', async () => {
    expect(await main(['run', '--dry-run', '--max-tokens', '100000', '-k', '1', '--flow', 'evaluate', ...base()])).toBe(
      0
    );
    const first = join((await lastRun()).dir, 'results.json');
    const second = join(scratch, 'second.json');
    const results = JSON.parse(await fs.readFile(first, 'utf8')) as ResultsFile;
    // The candidate run got every evaluate trial wrong; the baseline got them all right.
    const wrong = results.trials.map((t) => ({ ...t, correct: false, grade: undefined }));
    await fs.writeFile(second, JSON.stringify({ ...results, trials: wrong }));
    stdout.length = 0;
    expect(await main(['report', first, second])).toBe(0);
    const text = stdout.join('\n');
    expect(text).toMatch(/\| correct \| baseline \| 100\.0%/);
    expect(text).toMatch(/\| correct \| candidate \| 0\.0%/);
  });

  it('refuses to report a results file that is not single-arm (a compare run would pool both arms)', async () => {
    expect(await main(['run', '--dry-run', '--max-tokens', '100000', '-k', '1', '--flow', 'evaluate', ...base()])).toBe(
      0
    );
    const first = join((await lastRun()).dir, 'results.json');
    const twoArm = join(scratch, 'two-arm.json');
    const results = JSON.parse(await fs.readFile(first, 'utf8')) as ResultsFile;
    const candidate = { ...(results.arms[0] as ResultsFile['arms'][number]), name: 'candidate' };
    await fs.writeFile(
      twoArm,
      JSON.stringify({
        ...results,
        arms: [...results.arms, candidate],
        trials: [...results.trials, ...results.trials.map((t) => ({ ...t, arm: 'candidate' }))],
      })
    );
    stdout.length = 0;
    expect(await main(['report', first, twoArm])).toBe(1);
    expect(stderr.join('\n')).toContain(`${twoArm}: has 2 arms (baseline, candidate)`);
    expect(stdout.join('\n')).not.toContain('## Comparison');
  });

  it('refuses to report runs with different k', async () => {
    expect(await main(['run', '--dry-run', '--max-tokens', '100000', '-k', '1', '--flow', 'evaluate', ...base()])).toBe(
      0
    );
    const first = join((await lastRun()).dir, 'results.json');
    const other = join(scratch, 'other.json');
    const results = JSON.parse(await fs.readFile(first, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(other, JSON.stringify({ ...results, k: 2 }));
    expect(await main(['report', first, other])).toBe(1);
    expect(stderr.join('\n')).toContain('k differs');
  });

  it('prints usage and exits 0 for --help, 1 for a bad command', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(await main(['bogus'])).toBe(1);
  });
});
