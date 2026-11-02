import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import {
  buildCreatePrPrompt,
  createPrPromptDef,
  renderIssueRefs,
  renderTicketSummary,
} from '@src/integration/ai/prompts/create-pr/definition.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());

describe('renderTicketSummary', () => {
  it('renders each ticket as a bullet, with link when present', () => {
    const out = renderTicketSummary([{ title: 'first', link: 'https://example.com/1' }, { title: 'second' }]);
    expect(out).toContain('- first (https://example.com/1)');
    expect(out).toContain('- second');
  });

  it('returns an empty string when the list is empty (the template carries the fallback)', () => {
    expect(renderTicketSummary([])).toBe('');
  });
});

describe('renderIssueRefs', () => {
  it('joins refs as `Closes <ref>` lines', () => {
    expect(renderIssueRefs(['#123', '!456'])).toBe('Closes #123\nCloses !456');
  });

  it('returns empty string for no refs (the prompt then omits the closes block)', () => {
    expect(renderIssueRefs([])).toBe('');
  });
});

const SAMPLE_CONTRACT_SECTION = '## Output contract\n\nWrite signals.json. (test fixture body.)';

describe('buildCreatePrPrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt with the head/base branches and contract section', async () => {
    const result = await buildCreatePrPrompt(deps, {
      baseBranch: 'main',
      headBranch: 'feature/x',
      repositoryPath: '/work/repo',
      ticketSummary: '- ticket one',
      issueRefs: 'Closes #1',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain('<role>');
    expect(result.value).toContain('<goal>');
    expect(result.value).toContain('<success_criteria>');
    expect(result.value).toContain('`feature/x`');
    expect(result.value).toContain('`main`');
    expect(result.value).toContain('- ticket one');
    expect(result.value).toContain('Closes #1');
    expect(result.value).toContain("git -C '/work/repo' log main..HEAD");
    expect(result.value).toContain("git -C '/work/repo' diff main...HEAD --stat");
    expect(result.value).toContain('The repository is at\n`/work/repo`');
    expect(result.value).not.toContain('MUST NOT be able to tell');
    expect(result.value).not.toContain('authored the commits yourself');
    expect(result.value).not.toMatch(/em-dash/i);
    expect(result.value).toContain('## Output contract');
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('keeps the one-shot session going until the signals file is written', async () => {
    expect(createPrPromptDef.partials).toMatchObject({ ONE_SHOT_OPERATION: 'one-shot-operation' });
    const result = await buildCreatePrPrompt(deps, {
      baseBranch: 'main',
      headBranch: 'feature/x',
      repositoryPath: '/work/repo',
      ticketSummary: '',
      issueRefs: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flattened = result.value.replace(/\s+/g, ' ');
    expect(flattened.split('<one-shot-operation>')).toHaveLength(2);
    expect(flattened).toContain('keep going until `signals.json` is written at the path the output contract names');
    expect(flattened).toContain('only when nothing can proceed without the operator');
  });

  it('asks for literal prose with no metaphor, stock phrases or unprompted contrasts', async () => {
    const result = await buildCreatePrPrompt(deps, {
      baseBranch: 'main',
      headBranch: 'feature/x',
      repositoryPath: '/work/repo',
      ticketSummary: '',
      issueRefs: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flattened = result.value.replace(/\s+/g, ' ');
    expect(flattened).toContain('Say things literally');
    expect(flattened).toContain('no metaphor, no stock phrases');
    expect(flattened).toContain('no unprompted "X, not Y" contrasts');
    expect(flattened).not.toContain('Neither terse shorthand nor essay-length explanation');
  });

  it('quotes the repository path in every git command so a path with spaces stays one argument', async () => {
    const result = await buildCreatePrPrompt(deps, {
      baseBranch: 'main',
      headBranch: 'feature/x',
      repositoryPath: '/Users/me/My Projects/app',
      ticketSummary: '- ticket one',
      issueRefs: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const commands = result.value.match(/git -C \S.*/g) ?? [];
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) expect(cmd).toMatch(/^git -C '\/Users\/me\/My Projects\/app' /);
  });

  const renderCommands = async (repositoryPath: string): Promise<readonly string[]> => {
    const result = await buildCreatePrPrompt(deps, {
      baseBranch: 'main',
      headBranch: 'feature/x',
      repositoryPath,
      ticketSummary: '',
      issueRefs: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    if (!result.ok) throw result.error;
    return result.value.match(/git -C \S.*/g) ?? [];
  };

  it.each([
    ['/srv/$build/app', "'/srv/$build/app'"],
    ['/srv/a`b/app', "'/srv/a`b/app'"],
    ['/srv/$(id)/app', "'/srv/$(id)/app'"],
    ["/Users/o'brien/app", "'/Users/o'\\''brien/app'"],
  ])('single-quotes %s so the shell passes it to git untouched', async (path, quoted) => {
    const commands = await renderCommands(path);
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) expect(cmd.startsWith(`git -C ${quoted} `)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('the quoted path round-trips through a real POSIX shell', async () => {
    const path = '/srv/$build/a`b/$(id)/o\'brien "x"/app';
    const [cmd] = await renderCommands(path);
    const arg = /^git -C (.+?) log /.exec(cmd ?? '')?.[1] ?? '';
    expect(execFileSync('/bin/sh', ['-c', `printf %s ${arg}`], { encoding: 'utf8' })).toBe(path);
  });

  it('renders with empty issueRefs (the prompt instructs the AI to omit the closes block)', async () => {
    const result = await buildCreatePrPrompt(deps, {
      baseBranch: 'main',
      headBranch: 'feature/x',
      repositoryPath: '/work/repo',
      ticketSummary: '_no tickets_',
      issueRefs: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('rejects an empty output-contract section via the spec validator', async () => {
    const result = await buildCreatePrPrompt(deps, {
      baseBranch: 'main',
      headBranch: 'feature/x',
      repositoryPath: '/work/repo',
      ticketSummary: '',
      issueRefs: '',
      outputContractSection: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty baseBranch via the spec validator', async () => {
    const result = await buildCreatePrPrompt(deps, {
      baseBranch: '   ',
      headBranch: 'feature/x',
      repositoryPath: '/work/repo',
      ticketSummary: '',
      issueRefs: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
