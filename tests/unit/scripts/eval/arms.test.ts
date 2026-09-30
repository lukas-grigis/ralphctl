import { describe, expect, it } from 'vitest';
import { buildArm, DEFAULT_PRESET, hashTemplatesDir } from '../../../../scripts/eval/arms.ts';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arm = (opts: Parameters<typeof buildArm>[0]) => {
  const built = buildArm(opts);
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
};

describe('buildArm', () => {
  it('defaults to claude-economic: Sonnet on every row, effort resolved per role', () => {
    // claude-preset-matrices.ts CLAUDE_ECONOMIC: evaluator high, generator high, readiness low.
    const rows = arm({ name: 'baseline' }).rows;
    expect(DEFAULT_PRESET).toBe('claude-economic');
    expect(rows.evaluate).toEqual({ provider: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' });
    expect(rows.implement).toEqual({ provider: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' });
    expect(rows['select-candidate']).toEqual(rows.evaluate); // the judge runs on the evaluator row
    expect(rows['detect-scripts']).toEqual({ provider: 'claude-code', model: 'claude-sonnet-5-5', effort: 'low' }); // readiness row
  });

  it('accepts any preset name', () => {
    const rows = arm({ name: 'baseline', preset: 'claude-frontier' }).rows;
    expect(rows.evaluate.provider).toBe('claude-code');
    expect(arm({ name: 'baseline', preset: 'claude-frontier' }).label).toBe('claude-frontier');
  });

  it('replaces the overridden fields on every row and keeps the rest', () => {
    const built = arm({ name: 'candidate', model: 'claude-opus-5-5', effort: 'medium' });
    for (const flow of ['evaluate', 'implement', 'detect-scripts', 'select-candidate'] as const) {
      expect(built.rows[flow]).toMatchObject({ provider: 'claude-code', model: 'claude-opus-5-5', effort: 'medium' });
    }
    expect(built.label).toBe('claude-economic + override');
  });

  it('rejects an unknown preset or provider', () => {
    expect(buildArm({ name: 'x', preset: 'nope' }).ok).toBe(false);
    expect(buildArm({ name: 'x', provider: 'not-a-provider' }).ok).toBe(false);
  });

  it('passes a model override through unvalidated — the adapter validates model ids at spawn time', () => {
    // buildArm passes the id through; the provider adapter rejects unknown ids (ai-session model validation).
    // A Sonnet 5 arm is how an eval compares the preset's Sonnet 5.5 against its predecessor.
    expect(arm({ name: 'x', model: 'claude-sonnet-5' }).rows.evaluate.model).toBe('claude-sonnet-5');
  });
});

describe('hashTemplatesDir', () => {
  it('changes when a template changes and is stable otherwise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-tpl-'));
    try {
      await mkdir(join(dir, 'evaluate'), { recursive: true });
      await writeFile(join(dir, 'evaluate', 'template.md'), 'one');
      const first = await hashTemplatesDir(dir);
      expect(await hashTemplatesDir(dir)).toBe(first);
      await writeFile(join(dir, 'evaluate', 'template.md'), 'two');
      expect(await hashTemplatesDir(dir)).not.toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
