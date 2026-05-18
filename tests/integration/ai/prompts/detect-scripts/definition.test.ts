import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import {
  buildDetectScriptsPrompt,
  detectScriptsPromptDef,
} from '@src/integration/ai/prompts/detect-scripts/definition.ts';

const loader = createFsTemplateLoader(defaultTemplatesDir());

describe('detectScriptsPromptDef — completeness', () => {
  it('every placeholder in detect-scripts/template.md is declared by the definition', async () => {
    const path = `${String(defaultTemplatesDir())}/detect-scripts/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = extractPlaceholders(template);

    const declared = new Set([
      ...Object.values(detectScriptsPromptDef.parameters).map((p) => p.placeholder),
      ...Object.keys(detectScriptsPromptDef.partials ?? {}),
    ]);
    for (const placeholder of placeholders) {
      expect(declared.has(placeholder), `template uses {{${placeholder}}} but the def doesn't declare it`).toBe(true);
    }
  });

  it('every placeholder declared by the definition exists in detect-scripts/template.md', async () => {
    const path = `${String(defaultTemplatesDir())}/detect-scripts/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = new Set(extractPlaceholders(template));

    for (const spec of Object.values(detectScriptsPromptDef.parameters)) {
      expect(
        placeholders.has(spec.placeholder),
        `def declares {{${spec.placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
    for (const placeholder of Object.keys(detectScriptsPromptDef.partials ?? {})) {
      expect(
        placeholders.has(placeholder),
        `def declares partial slot {{${placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
  });

  it('expectedSignals advertises setup-script, verify-script, and note', () => {
    expect(detectScriptsPromptDef.expectedSignals).toEqual(['setup-script', 'verify-script', 'note']);
  });
});

describe('buildDetectScriptsPrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt threading the repository path through', async () => {
    const result = await buildDetectScriptsPrompt(loader, { repositoryPath: '/repo/api' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value as unknown as string;
    expect(body).toContain('# Repository Script Detection Protocol');
    expect(body).toContain('/repo/api');
    expect(body).toContain('<setup-script>');
    expect(body).toContain('<verify-script>');
    // No placeholders remain.
    expect(body).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('rejects an empty repositoryPath via the spec validator', async () => {
    const result = await buildDetectScriptsPrompt(loader, { repositoryPath: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});

describe('detect-scripts template — detection guidance', () => {
  /**
   * The detection prompt drives the AI's behaviour on every repo we point it at. These
   * assertions guard against regressions in the guidance content: removing the context-first
   * instruction, narrowing the inspection scope to one stack family, or dropping the polyglot
   * principle would all silently shrink what the AI proposes. We test the rendered prompt body
   * (after substitution) so the AI sees exactly what we assert against.
   */
  const renderedBody = async (): Promise<string> => {
    const r = await buildDetectScriptsPrompt(loader, { repositoryPath: '/repo/x' });
    if (!r.ok) throw r.error;
    return r.value as unknown as string;
  };

  it('instructs the AI to read coding-agent context files first', async () => {
    const body = await renderedBody();
    // The constraint block must explicitly position coding-agent context files as the primary
    // (strongest) evidence source — before manifests.
    expect(body).toMatch(/Coding-agent context files are the strongest evidence/i);
    // The two canonical coding-agent context filenames must be named explicitly.
    expect(body).toMatch(/CLAUDE\.md/);
    expect(body).toMatch(/AGENTS\.md/);
  });

  it('treats a coding-agent context file as valid standalone evidence', async () => {
    const body = await renderedBody();
    // The constraint block must explicitly elevate context files over manifest inference —
    // without this the AI dismisses CLAUDE.md-stated commands as inferred guesses.
    expect(body).toMatch(/lift it verbatim/i);
    // Must also instruct the AI to prefer context files over manifest inference.
    expect(body).toMatch(/Prefer this over any inference from manifest/i);
  });

  it('does not bias the scope toward a specific stack family', async () => {
    const body = await renderedBody();
    // Before this prompt was generalised, the inspection scope hard-listed JS / Python / Rust /
    // Go manifests and excluded JVM/.NET — a Maven monorepo silently returned empty. The new
    // guidance describes file *categories* (manifests, lockfiles, build descriptors…) instead
    // of enumerating filenames per language.
    expect(body).toMatch(/manifests[\s\S]*lockfiles[\s\S]*build descriptors/i);
  });

  it('teaches the polyglot-monorepo chain principle generically', async () => {
    const body = await renderedBody();
    // Must mention polyglot monorepos AND the chaining principle (one tool per sub-tree, &&
    // composition, directory flags). No specific stack name should appear in this section
    // (mvn / pnpm / gradle / cargo) — the prior version baked the user's example verbatim.
    const polyglotSection = body.slice(body.indexOf('Polyglot'));
    expect(polyglotSection.length).toBeGreaterThan(0);
    expect(polyglotSection).toMatch(/chain.+sub-tree/i);
    expect(polyglotSection).toMatch(/directory flag/i);
    // Section must NOT bake in stack-specific recipes.
    const head = polyglotSection.slice(0, polyglotSection.indexOf('Evidence rule'));
    expect(head).not.toMatch(/\bmvn\b/);
    expect(head).not.toMatch(/\bpnpm\b/);
    expect(head).not.toMatch(/\bgradle\b/);
    expect(head).not.toMatch(/\bcargo\b/);
  });

  it('keeps the read-only invariant — the proposal step must not edit or run', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/read-only/i);
    expect(body).toMatch(/Do not modify the working tree/);
    // "do not run commands" may span a soft line-wrap in the template source.
    expect(body).toMatch(/do not run[\s\S]{0,5}commands/i);
  });

  it('mandates an evidence-or-omit rule on every proposed command', async () => {
    const body = await renderedBody();
    // The template must state explicitly when to emit vs omit — framed as "emit when
    // documented, omit when silent" rather than a blanket silence-is-safer rule.
    expect(body).toMatch(/Emit when documented, omit when silent/i);
    expect(body).toMatch(/omit.*when the project.*files are silent/i);
  });
});
