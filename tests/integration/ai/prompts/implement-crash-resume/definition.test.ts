import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import { buildPrompt } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import {
  buildImplementCrashResumePrompt,
  implementCrashResumePromptDef,
} from '@src/integration/ai/prompts/implement-crash-resume/definition.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());
const TEMPLATE_PATH = `${String(defaultTemplatesDir())}/implement-crash-resume/template.md`;
const SECTION = '## Output contract\n\nWrite /tmp/ralph/rounds/2/generator/signals.json. (fixture body.)';

describe('implementCrashResumePromptDef — completeness', () => {
  it('every template placeholder is declared by the definition', async () => {
    const placeholders = extractPlaceholders(await fs.readFile(TEMPLATE_PATH, 'utf8'));
    const declared = new Set([
      ...Object.values(implementCrashResumePromptDef.parameters).map((p) => p.placeholder),
      ...Object.keys(implementCrashResumePromptDef.partials ?? {}),
    ]);
    for (const placeholder of placeholders) {
      expect(declared.has(placeholder), `template uses {{${placeholder}}} but the def doesn't declare it`).toBe(true);
    }
  });

  it('every declared placeholder exists in the template', async () => {
    const placeholders = new Set(extractPlaceholders(await fs.readFile(TEMPLATE_PATH, 'utf8')));
    for (const spec of Object.values(implementCrashResumePromptDef.parameters)) {
      expect(placeholders.has(spec.placeholder), `def declares {{${spec.placeholder}}} but template omits it`).toBe(
        true
      );
    }
  });
});

describe('buildImplementCrashResumePrompt — against the real template', () => {
  it('renders the reconcile instruction and the round output contract with no leftover placeholders', async () => {
    const result = await buildImplementCrashResumePrompt(deps, { outputContractSection: SECTION });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flat = result.value.replace(/\s+/g, ' ');
    expect(flat).toContain('was interrupted');
    expect(flat).toContain('`git status` and `git diff`');
    expect(flat).toContain('continue the task to completion');
    expect(result.value).toContain('rounds/2/generator/signals.json');
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('hardcodes no package-manager command', async () => {
    const template = await fs.readFile(TEMPLATE_PATH, 'utf8');
    expect(template).not.toMatch(/\b(pnpm|npm|yarn|cargo|pip|go test)\b/);
  });

  it('rejects an empty outputContractSection', async () => {
    const result = await buildPrompt(deps, implementCrashResumePromptDef, { outputContractSection: '  ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
