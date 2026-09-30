import { describe, expect, it } from 'vitest';
import { parseCommand, type Command } from '../../../../scripts/eval/cli.ts';

const ok = (argv: string[]): Command => {
  const parsed = parseCommand(argv);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};
const err = (argv: string[]): string => {
  const parsed = parseCommand(argv);
  if (parsed.ok) throw new Error('expected a parse error');
  return parsed.error.message;
};

describe('parseCommand', () => {
  it('parses check with filters', () => {
    expect(ok(['check', '--flow', 'evaluate,implement', '--fixture', 'ev-*', '--tier', 'capability'])).toEqual({
      kind: 'check',
      options: { flows: ['evaluate', 'implement'], idGlob: 'ev-*', tier: 'capability' },
    });
  });

  it('requires --max-tokens for run (fail closed, no default)', () => {
    expect(err(['run'])).toContain('--max-tokens is required');
    expect(err(['compare', '--candidate-model', 'm'])).toContain('--max-tokens is required');
  });

  it('parses run with defaults', () => {
    const cmd = ok(['run', '--max-tokens', '50000']);
    expect(cmd).toMatchObject({
      kind: 'run',
      options: {
        k: 3,
        maxTokens: 50_000,
        reserveTokens: 0,
        allowUnmetered: false,
        dryRun: false,
        keepWorkspaces: false,
        flows: [],
      },
    });
  });

  it('parses every run flag', () => {
    const cmd = ok([
      'run',
      '--max-tokens',
      '9',
      '-k',
      '5',
      '--flow',
      'detect-scripts',
      '--preset',
      'claude-fast',
      '--provider',
      'claude-code',
      '--model',
      'claude-sonnet-5',
      '--effort',
      'low',
      '--max-wall-min',
      '30',
      '--reserve-tokens',
      '7',
      '--allow-unmetered',
      '--keep-workspaces',
      '--dry-run',
      '--fixtures-dir',
      '/f',
      '--results-dir',
      '/r',
    ]);
    expect(cmd).toEqual({
      kind: 'run',
      options: {
        flows: ['detect-scripts'],
        k: 5,
        maxTokens: 9,
        reserveTokens: 7,
        maxWallMin: 30,
        allowUnmetered: true,
        keepWorkspaces: true,
        dryRun: true,
        fixturesDir: '/f',
        resultsDir: '/r',
        baseline: { preset: 'claude-fast', provider: 'claude-code', model: 'claude-sonnet-5', effort: 'low' },
      },
    });
  });

  it('rejects unknown flows, tiers, commands and stray positionals', () => {
    expect(err(['check', '--flow', 'plan'])).toContain("unknown flow 'plan'");
    expect(err(['check', '--tier', 'nightly'])).toContain('--tier');
    expect(err(['bench'])).toContain("unknown command 'bench'");
    expect(err(['check', 'oops'])).toContain('unexpected argument');
    expect(err(['run', '--max-tokens', '5', '--bogus'])).toContain('bogus');
  });

  it('rejects non-positive numbers', () => {
    expect(err(['run', '--max-tokens', '0'])).toContain('positive integer');
    expect(err(['run', '--max-tokens', '5', '-k', '1.5'])).toContain('--k');
  });

  it('compare needs exactly one candidate kind', () => {
    expect(err(['compare', '--max-tokens', '5'])).toContain('exactly one of');
    expect(err(['compare', '--max-tokens', '5', '--candidate-templates', '/t', '--candidate-model', 'm'])).toContain(
      'exactly one of'
    );
  });

  it('compare with a template directory or a model', () => {
    expect(ok(['compare', '--max-tokens', '5', '--candidate-templates', '/t'])).toMatchObject({
      kind: 'compare',
      candidate: { templatesDir: '/t' },
    });
    expect(
      ok([
        'compare',
        '--max-tokens',
        '5',
        '--candidate-model',
        'm',
        '--candidate-provider',
        'claude-code',
        '--candidate-effort',
        'high',
      ])
    ).toMatchObject({ kind: 'compare', candidate: { model: 'm', provider: 'claude-code', effort: 'high' } });
  });

  it('refuses candidate provider/effort with a template candidate, and candidate flags on run', () => {
    expect(err(['compare', '--max-tokens', '5', '--candidate-templates', '/t', '--candidate-effort', 'low'])).toContain(
      '--candidate-model'
    );
    expect(err(['run', '--max-tokens', '5', '--candidate-model', 'm'])).toContain('belongs to `compare`');
  });

  it('report takes exactly two paths', () => {
    expect(ok(['report', 'a/results.json', 'b/results.json'])).toEqual({
      kind: 'report',
      baselinePath: 'a/results.json',
      candidatePath: 'b/results.json',
    });
    expect(err(['report', 'a'])).toContain('exactly two paths');
    expect(err(['report', 'a', 'b', 'c'])).toContain('exactly two paths');
  });

  it('prints usage for no command or --help', () => {
    expect(err([])).toContain('pnpm eval <command>');
    expect(err(['--help'])).toContain('pnpm eval <command>');
  });
});
