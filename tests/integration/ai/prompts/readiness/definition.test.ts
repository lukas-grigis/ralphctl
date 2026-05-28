import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { absentState, presentState } from '@src/integration/ai/readiness/_engine/state.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { absolutePath, FIXED_NOW } from '@tests/fixtures/domain.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import {
  buildReadinessPrompt,
  collectArtefactPaths,
  conventionsPartialName,
  readinessPromptDef,
  renderDetectedArtefacts,
  renderExistingContextFile,
} from '@src/integration/ai/prompts/readiness/definition.ts';
import { Slug } from '@src/domain/value/slug.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());

describe('readinessPromptDef — completeness', () => {
  it('every placeholder in readiness.md is declared by the definition (parameters or partials)', async () => {
    const path = `${String(defaultTemplatesDir())}/readiness/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = extractPlaceholders(template);

    const declared = new Set([
      ...Object.values(readinessPromptDef.parameters).map((p) => p.placeholder),
      ...Object.keys(readinessPromptDef.partials ?? {}),
    ]);
    for (const placeholder of placeholders) {
      expect(declared.has(placeholder), `template uses {{${placeholder}}} but the def doesn't declare it`).toBe(true);
    }
  });

  it('every placeholder declared by the definition exists in readiness.md', async () => {
    const path = `${String(defaultTemplatesDir())}/readiness/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = new Set(extractPlaceholders(template));

    for (const spec of Object.values(readinessPromptDef.parameters)) {
      expect(
        placeholders.has(spec.placeholder),
        `def declares {{${spec.placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
    for (const placeholder of Object.keys(readinessPromptDef.partials ?? {})) {
      expect(
        placeholders.has(placeholder),
        `def declares partial slot {{${placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
  });

  it('expectedSignals advertises the audit-[09] readiness sub-union', () => {
    expect(readinessPromptDef.expectedSignals).toEqual([
      'agents-md-proposal',
      'setup-skill-proposal',
      'verify-skill-proposal',
      'skill-suggestions',
      'note',
    ]);
  });
});

describe('renderExistingContextFile', () => {
  it('wraps a non-empty body in <existing-context>...</existing-context>', () => {
    const out = renderExistingContextFile('# old body\n\n- bullet');
    expect(out).toContain('<existing-context>');
    expect(out).toContain('# old body');
    expect(out).toContain('- bullet');
    expect(out).toContain('</existing-context>');
  });

  it('emits an explicit "no existing file" line when body is undefined or whitespace', () => {
    expect(renderExistingContextFile(undefined)).toContain('no existing context file');
    expect(renderExistingContextFile('   \n  ')).toContain('no existing context file');
  });
});

describe('renderDetectedArtefacts', () => {
  it('renders paths as a markdown bullet list with backticks', () => {
    const out = renderDetectedArtefacts(['/repo/CLAUDE.md', '/repo/.claude/settings.json']);
    expect(out).toContain('- `/repo/CLAUDE.md`');
    expect(out).toContain('- `/repo/.claude/settings.json`');
  });

  it('emits an explicit "no artefacts detected" line for an empty list', () => {
    expect(renderDetectedArtefacts([])).toContain('no artefacts detected');
  });
});

describe('collectArtefactPaths', () => {
  it('returns [] for absent state', () => {
    expect(collectArtefactPaths(absentState(FIXED_NOW))).toEqual([]);
  });

  it('walks claude-code artifacts (root + named collections)', () => {
    const slugA = Slug.parse('skill-a');
    expect(slugA.ok).toBe(true);
    if (!slugA.ok) return;
    const state = presentState(FIXED_NOW, {
      tool: 'claude-code',
      claudeMd: { path: absolutePath('/repo/CLAUDE.md') },
      settings: { path: absolutePath('/repo/.claude/settings.json') },
      skills: [{ name: slugA.value, path: absolutePath('/repo/.claude/skills/skill-a/SKILL.md') }],
      commands: [],
      agents: [],
      hooks: [],
    });
    const paths = collectArtefactPaths(state);
    expect(paths).toEqual(['/repo/CLAUDE.md', '/repo/.claude/settings.json', '/repo/.claude/skills/skill-a/SKILL.md']);
  });

  it('walks copilot artifacts', () => {
    const state = presentState(FIXED_NOW, {
      tool: 'copilot',
      copilotInstructions: { path: absolutePath('/repo/.github/copilot-instructions.md') },
    });
    expect(collectArtefactPaths(state)).toEqual(['/repo/.github/copilot-instructions.md']);
  });
});

const SAMPLE_CONTRACT_SECTION = '## Output contract\n\nWrite signals.json. (test fixture body.)';

describe('buildReadinessPrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt for an absent probe state', async () => {
    const result = await buildReadinessPrompt(deps, {
      repositoryPath: '/repo/main',
      currentTool: 'claude-code',
      probedState: absentState(FIXED_NOW),
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value as unknown as string;
    expect(body).toContain('<role>');
    expect(body).toContain('<goal>');
    expect(body).toContain('/repo/main');
    expect(body).toContain('claude-code');
    expect(body).toContain('no artefacts detected');
    expect(body).toContain('no existing context file');
    expect(body).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('threads an existing context body verbatim into the rendered prompt', async () => {
    const existing = '# Acme API\n\n## Build & Run\n- `pnpm install`';
    const result = await buildReadinessPrompt(deps, {
      repositoryPath: '/repo/api',
      currentTool: 'claude-code',
      probedState: absentState(FIXED_NOW),
      existingContextFile: existing,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value as unknown as string;
    expect(body).toContain('<existing-context>');
    expect(body).toContain('# Acme API');
    expect(body).toContain('## Build & Run');
  });

  it('rejects an empty repositoryPath via the spec validator', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, readinessPromptDef, {
      repositoryPath: '   ',
      currentTool: 'claude-code',
      wireTag: 'claude-md',
      existingContextFile: 'x',
      detectedArtefacts: 'x',
      targetFileConventions: 'x',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('embeds the WIRE_TAG = "claude-md" identifier for the claude-code tool', async () => {
    const result = await buildReadinessPrompt(deps, {
      repositoryPath: '/repo/main',
      currentTool: 'claude-code',
      probedState: absentState(FIXED_NOW),
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
    const body = result.value as unknown as string;
    // The Wave-6 template instructs the AI to use `tag: "claude-md"` on its signal — no
    // XML wrappers. The wire-tag identifier appears as the quoted string value.
    expect(body).toContain('"claude-md"');
    expect(body).not.toContain('"agents-md"');
    expect(body).not.toContain('"copilot-instructions"');
  });

  it('embeds the WIRE_TAG = "copilot-instructions" identifier for the copilot tool', async () => {
    const result = await buildReadinessPrompt(deps, {
      repositoryPath: '/repo/main',
      currentTool: 'copilot',
      probedState: absentState(FIXED_NOW),
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
    const body = result.value as unknown as string;
    expect(body).toContain('"copilot-instructions"');
    expect(body).not.toContain('"agents-md"');
    expect(body).not.toContain('"claude-md"');
  });

  it('embeds the WIRE_TAG = "agents-md" identifier for the codex tool', async () => {
    const result = await buildReadinessPrompt(deps, {
      repositoryPath: '/repo/main',
      currentTool: 'codex',
      probedState: absentState(FIXED_NOW),
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
    const body = result.value as unknown as string;
    expect(body).toContain('"agents-md"');
    expect(body).not.toContain('"claude-md"');
    expect(body).not.toContain('"copilot-instructions"');
  });
});

describe('conventionsPartialName', () => {
  it('maps claude-code → conventions-claude-md', () => {
    expect(conventionsPartialName('claude-code')).toBe('conventions-claude-md');
  });
  it('maps copilot → conventions-copilot-instructions', () => {
    expect(conventionsPartialName('copilot')).toBe('conventions-copilot-instructions');
  });
  it('maps codex → conventions-agents-md', () => {
    expect(conventionsPartialName('codex')).toBe('conventions-agents-md');
  });
});

describe('buildReadinessPrompt — per-tool conventions partial selection', () => {
  it('injects CLAUDE.md conventions for claude-code (distinctive first-line phrase)', async () => {
    const result = await buildReadinessPrompt(deps, {
      repositoryPath: '/repo/main',
      currentTool: 'claude-code',
      probedState: absentState(FIXED_NOW),
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
    const body = result.value as unknown as string;
    // Distinctive text from conventions-claude-md.md
    expect(body).toContain("Claude Code's native project context file");
  });

  it('injects Copilot conventions for copilot (distinctive first-line phrase)', async () => {
    const result = await buildReadinessPrompt(deps, {
      repositoryPath: '/repo/main',
      currentTool: 'copilot',
      probedState: absentState(FIXED_NOW),
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
    const body = result.value as unknown as string;
    // Distinctive text from conventions-copilot-instructions.md
    expect(body).toContain("GitHub Copilot's native project context file");
  });

  it('injects AGENTS.md conventions for codex (distinctive first-line phrase)', async () => {
    const result = await buildReadinessPrompt(deps, {
      repositoryPath: '/repo/main',
      currentTool: 'codex',
      probedState: absentState(FIXED_NOW),
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
    const body = result.value as unknown as string;
    // Distinctive text from conventions-agents-md.md
    expect(body).toContain('cross-tool agent context file');
  });
});
