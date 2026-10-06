import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import {
  buildCreatePrPrompt,
  createPrPromptDef,
  renderIssueRefs,
  renderTicketSummary,
} from '@src/integration/ai/prompts/create-pr/definition.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());

describe('createPrPromptDef — completeness', () => {
  it('every placeholder in create-pr/template.md is declared by the definition (parameters or partials)', async () => {
    const path = `${String(defaultTemplatesDir())}/create-pr/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = extractPlaceholders(template);

    const declared = new Set([
      ...Object.values(createPrPromptDef.parameters).map((p) => p.placeholder),
      ...Object.keys(createPrPromptDef.partials ?? {}),
    ]);
    for (const placeholder of placeholders) {
      expect(declared.has(placeholder), `template uses {{${placeholder}}} but the def doesn't declare it`).toBe(true);
    }
  });

  it('every placeholder declared by the definition exists in create-pr/template.md', async () => {
    const path = `${String(defaultTemplatesDir())}/create-pr/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = new Set(extractPlaceholders(template));

    for (const spec of Object.values(createPrPromptDef.parameters)) {
      expect(
        placeholders.has(spec.placeholder),
        `def declares {{${spec.placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
    for (const placeholder of Object.keys(createPrPromptDef.partials ?? {})) {
      expect(
        placeholders.has(placeholder),
        `def declares partial slot {{${placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
  });
});

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
    expect(result.value).toContain('git -C "/work/repo" log main..HEAD');
    expect(result.value).toContain('git -C "/work/repo" diff main...HEAD --stat');
    expect(result.value).not.toContain('MUST NOT be able to tell');
    expect(result.value).not.toContain('authored the commits yourself');
    expect(result.value).not.toMatch(/em-dash/i);
    expect(result.value).toContain('## Output contract');
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
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
    for (const cmd of commands) expect(cmd).toMatch(/^git -C "\/Users\/me\/My Projects\/app" /);
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
