import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { makePendingTicket } from '@tests/fixtures/domain.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import {
  buildRefinePrompt,
  refinePromptDef,
  renderIssueContextSection,
  renderTicket,
} from '@src/integration/ai/prompts/refine/definition.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());

describe('refinePromptDef — completeness', () => {
  it('every placeholder in refine.md is declared by the definition (parameters or partials)', async () => {
    const path = `${String(defaultTemplatesDir())}/refine/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = extractPlaceholders(template);

    const declared = new Set([
      ...Object.values(refinePromptDef.parameters).map((p) => p.placeholder),
      ...Object.keys(refinePromptDef.partials ?? {}),
    ]);
    for (const placeholder of placeholders) {
      expect(declared.has(placeholder), `template uses {{${placeholder}}} but the def doesn't declare it`).toBe(true);
    }
  });

  it('every placeholder declared by the definition exists in refine.md', async () => {
    const path = `${String(defaultTemplatesDir())}/refine/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = new Set(extractPlaceholders(template));

    for (const spec of Object.values(refinePromptDef.parameters)) {
      expect(
        placeholders.has(spec.placeholder),
        `def declares {{${spec.placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
    for (const placeholder of Object.keys(refinePromptDef.partials ?? {})) {
      expect(
        placeholders.has(placeholder),
        `def declares partial slot {{${placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
  });
});

describe('renderTicket', () => {
  it('renders title and id, plus link and description when present', () => {
    const ticket = makePendingTicket({ title: 'Add CSV export' });
    const out = renderTicket(ticket);
    expect(out).toContain('**Title:** Add CSV export');
    expect(out).toContain(`**ID:** ${String(ticket.id)}`);
  });

  it('omits the description block entirely when description is missing or whitespace', () => {
    const ticket = makePendingTicket({ title: 'X' });
    expect(renderTicket(ticket)).not.toContain('**Description:**');
  });
});

describe('renderIssueContextSection', () => {
  it('wraps a fetched body in <context>...</context>', () => {
    const ticket = makePendingTicket();
    const out = renderIssueContextSection(ticket, '## issue\n\n- bullet');
    expect(out).toContain('<context>');
    expect(out).toContain('## issue');
    expect(out).toContain('- bullet');
  });

  it('returns empty string when the ticket has no link and no fetched body', () => {
    const ticket = makePendingTicket();
    expect(renderIssueContextSection(ticket, undefined)).toBe('');
  });
});

describe('buildRefinePrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt with title, id, and OUTPUT_FILE', async () => {
    const ticket = makePendingTicket({ title: 'Add CSV export' });
    const result = await buildRefinePrompt(deps, {
      ticket,
      outputFilePath: '/tmp/req.json',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain('# Requirements Refinement Protocol');
    expect(result.value).toContain('**Title:** Add CSV export');
    expect(result.value).toContain('/tmp/req.json');
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('includes the issue-context block when fetched context is supplied', async () => {
    const ticket = makePendingTicket();
    const result = await buildRefinePrompt(deps, {
      ticket,
      outputFilePath: '/tmp/req.json',
      issueContext: '## issue body',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('## issue body');
  });

  it('rejects an empty rendered ticket via the spec validator', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, refinePromptDef, { ticket: '   ', outputFilePath: '/tmp/x.json' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty output file path via the spec validator', async () => {
    const ticket = makePendingTicket({ title: 'X' });
    const result = await buildRefinePrompt(deps, { ticket, outputFilePath: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
