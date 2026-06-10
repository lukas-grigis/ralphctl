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

  it('expectedSignals advertises setup-script, verify-script, verify-gates, and note', () => {
    expect(detectScriptsPromptDef.expectedSignals).toEqual(['setup-script', 'verify-script', 'verify-gates', 'note']);
  });
});

describe('buildDetectScriptsPrompt — end-to-end against the real template', () => {
  const EXAMPLE_CONTRACT = '## Output contract\n\nWrite signals.json to /tmp/out.';

  it('produces a fully-substituted prompt threading the repository path through', async () => {
    const result = await buildDetectScriptsPrompt(loader, {
      repositoryPath: '/repo/api',
      outputContractSection: EXAMPLE_CONTRACT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value as unknown as string;
    expect(body).toContain('<role>');
    expect(body).toContain('<goal>');
    expect(body).toContain('<output_contract>');
    expect(body).toContain('/repo/api');
    expect(body).toContain('## Output contract');
    // No placeholders remain.
    expect(body).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('rejects an empty repositoryPath via the spec validator', async () => {
    const result = await buildDetectScriptsPrompt(loader, {
      repositoryPath: '   ',
      outputContractSection: EXAMPLE_CONTRACT,
    });
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
    const r = await buildDetectScriptsPrompt(loader, {
      repositoryPath: '/repo/x',
      outputContractSection: '## Output contract\n\nWrite signals.json to /tmp/out.',
    });
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
    // composition, directory flags). The polyglot *paragraph itself* must not bake in stack
    // names (mvn / pnpm / gradle / cargo) — the prior version baked the user's example verbatim.
    // We slice the polyglot paragraph specifically (up to the next double-newline) rather than
    // everything after the anchor, because legitimate JVM-flag guidance + worked examples
    // downstream of the polyglot block do name those tools by necessity.
    const polyglotStart = body.indexOf('Polyglot');
    const polyglotParagraph = body.slice(polyglotStart, body.indexOf('\n\n', polyglotStart));
    expect(polyglotParagraph.length).toBeGreaterThan(0);
    expect(polyglotParagraph).toMatch(/chain.+sub-tree/i);
    expect(polyglotParagraph).toMatch(/directory flag/i);
    // Paragraph must NOT bake in stack-specific recipes.
    expect(polyglotParagraph).not.toMatch(/\bmvn\b/);
    expect(polyglotParagraph).not.toMatch(/\bpnpm\b/);
    expect(polyglotParagraph).not.toMatch(/\bgradle\b/);
    expect(polyglotParagraph).not.toMatch(/\bcargo\b/);
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

  it('gates the verify-gates signal on monorepos with separable module roots', async () => {
    const body = await renderedBody();
    // The per-module gate block must (a) name the signal, (b) restrict it to monorepos, and
    // (c) state the single-module exception inline — dropping any of these silently widens or
    // narrows what the AI proposes.
    expect(body).toMatch(/Per-module verify gates/i);
    expect(body).toMatch(/separable module roots/i);
    expect(body).toMatch(/single-module repository .* the verify script alone/i);
  });

  it('frames verify-gates as additive to the verify script, never a replacement', async () => {
    const body = await renderedBody();
    // The ADDITIVE contract is load-bearing: gates persist alongside the legacy script fallback.
    expect(body).toMatch(/`verify-gates` signal is ADDITIVE/);
    expect(body).toMatch(/alongside the `verify-script` signal, never[\s\S]{0,12}instead of it/i);
  });

  it('pins the gate field names the schema parses (pathPrefix, command, timeoutMs)', async () => {
    const body = await renderedBody();
    // Field-name drift between template and schema silently drops the whole signal. The
    // documented output contract MUST name the exact keys the Zod schema reads.
    expect(body).toMatch(/`pathPrefix`/);
    expect(body).toMatch(/`command`/);
    expect(body).toMatch(/`timeoutMs`/);
  });

  it('does not hardcode a package manager in the verify-gates guidance paragraph', async () => {
    const body = await renderedBody();
    // House rule: no hardcoded package-manager names in prose. The gate guidance must phrase
    // commands generically ("the module's own check / test entry point"). The worked JSON
    // examples downstream legitimately use the `<tool>` placeholder, so we slice the prose
    // block specifically — from its CONSTRAINT heading (not the same phrase in the
    // success-criteria summary above) to the end of the constraints block. Anchoring on the
    // bold heading skips the JVM-flag constraint (which legitimately names mvn/gradle).
    const start = body.indexOf('**Per-module verify gates');
    const block = body.slice(start, body.indexOf('</constraints>', start));
    expect(block.length).toBeGreaterThan(0);
    // The phrase soft-wraps in the template source — allow the line break between the two halves.
    expect(block).toMatch(/check \/ test[\s\S]{0,6}entry point/i);
    expect(block).not.toMatch(/\bpnpm\b/);
    expect(block).not.toMatch(/\bnpm\b/);
    expect(block).not.toMatch(/\byarn\b/);
    expect(block).not.toMatch(/\bcargo\b/);
    expect(block).not.toMatch(/\bmvn\b/);
    expect(block).not.toMatch(/\bgradle\b/);
  });
});
