import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Result } from '@src/domain/result.ts';
import { createTask, type TodoTask } from '@src/domain/entity/task.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { FIXED_REPOSITORY_ID, makeApprovedTicket, makeTodoTask } from '@tests/fixtures/domain.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import {
  buildImplementPrompt,
  implementPromptDef,
  renderVerifyScriptSection,
  renderPriorCritiqueSection,
  renderProjectToolingSection,
  renderTaskDescriptionSection,
  renderTaskStepsSection,
  renderVerificationCriteriaSection,
} from '@src/integration/ai/prompts/implement/definition.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error('unexpected error in test fixture');
  return r.value as T;
};

const makeTaskWith = (overrides: {
  name?: string;
  description?: string;
  steps?: readonly string[];
  verificationCriteria?: readonly string[];
}): TodoTask => {
  const ticket = makeApprovedTicket();
  return unwrap(
    createTask({
      name: overrides.name ?? 'do-the-work',
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      steps: overrides.steps !== undefined ? [...overrides.steps] : ['step 1'],
      verificationCriteria:
        overrides.verificationCriteria !== undefined ? [...overrides.verificationCriteria] : ['runs to completion'],
      order: 1,
      ticketId: ticket.id,
      repositoryId: FIXED_REPOSITORY_ID,
    })
  );
};

describe('implementPromptDef — completeness', () => {
  it('every placeholder in implement.md is declared by the definition (parameters or partials)', async () => {
    const path = `${String(defaultTemplatesDir())}/implement/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = extractPlaceholders(template);

    const declared = new Set([
      ...Object.values(implementPromptDef.parameters).map((p) => p.placeholder),
      ...Object.keys(implementPromptDef.partials ?? {}),
    ]);
    for (const placeholder of placeholders) {
      expect(declared.has(placeholder), `template uses {{${placeholder}}} but the def doesn't declare it`).toBe(true);
    }
  });

  it('every placeholder declared by the definition exists in implement.md', async () => {
    const path = `${String(defaultTemplatesDir())}/implement/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = new Set(extractPlaceholders(template));

    for (const spec of Object.values(implementPromptDef.parameters)) {
      expect(
        placeholders.has(spec.placeholder),
        `def declares {{${spec.placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
    for (const placeholder of Object.keys(implementPromptDef.partials ?? {})) {
      expect(
        placeholders.has(placeholder),
        `def declares partial slot {{${placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
  });

  it('declares the documented harness signals the implement response is expected to carry', () => {
    expect(implementPromptDef.expectedSignals).toEqual([
      'progress',
      'note',
      'task-verified',
      'task-complete',
      'task-blocked',
      'commit-message',
    ]);
  });
});

describe('renderTaskDescriptionSection', () => {
  it('renders a heading + body when description is present', () => {
    const task = makeTaskWith({ description: 'Wire up the export endpoint.' });
    const out = renderTaskDescriptionSection(task);
    expect(out).toContain('## Description');
    expect(out).toContain('Wire up the export endpoint.');
  });

  it('returns the empty string when description is omitted', () => {
    const task = makeTodoTask();
    expect(renderTaskDescriptionSection(task)).toBe('');
  });
});

describe('renderTaskStepsSection', () => {
  it('renders a numbered list with a heading', () => {
    const task = makeTaskWith({ steps: ['read the file', 'edit the function', 'run tests'] });
    const out = renderTaskStepsSection(task);
    expect(out).toContain('## Implementation Steps');
    expect(out).toContain('1. read the file');
    expect(out).toContain('2. edit the function');
    expect(out).toContain('3. run tests');
  });

  it('returns the empty string when there are no steps', () => {
    // The createTask API forbids constructing a task without steps via overrides — but the
    // renderer must stay defensive against a malformed plan. Hand-craft the input shape.
    const task = { ...makeTodoTask(), steps: [] as readonly string[] } as TodoTask;
    expect(renderTaskStepsSection(task)).toBe('');
  });
});

describe('renderVerificationCriteriaSection', () => {
  it('renders a bullet list with a heading', () => {
    const task = makeTaskWith({ verificationCriteria: ['lint passes', 'tests green'] });
    const out = renderVerificationCriteriaSection(task);
    expect(out).toContain('## Done criteria');
    expect(out).toContain('- lint passes');
    expect(out).toContain('- tests green');
  });

  it('returns the empty string when no criteria are declared', () => {
    const task = { ...makeTodoTask(), verificationCriteria: [] as readonly string[] } as TodoTask;
    expect(renderVerificationCriteriaSection(task)).toBe('');
  });
});

describe('renderVerifyScriptSection', () => {
  it('embeds the configured command as a fenced shell block', () => {
    const out = renderVerifyScriptSection('npm run check');
    expect(out).toContain('```sh');
    expect(out).toContain('npm run check');
    expect(out).toContain('post-task gate');
  });

  it('returns the explicit "no check script configured" line when undefined', () => {
    expect(renderVerifyScriptSection(undefined)).toBe('No verify script configured for this repo.');
  });

  it('returns the explicit "no check script configured" line when empty / whitespace', () => {
    expect(renderVerifyScriptSection('')).toBe('No verify script configured for this repo.');
    expect(renderVerifyScriptSection('   \n\t')).toBe('No verify script configured for this repo.');
  });
});

describe('renderProjectToolingSection', () => {
  it('returns the input trimmed when non-empty', () => {
    expect(renderProjectToolingSection('  - subagent: security-audit  ')).toBe('- subagent: security-audit');
  });

  it('falls back to "(none detected)" when undefined or empty', () => {
    expect(renderProjectToolingSection(undefined)).toBe('_(none detected)_');
    expect(renderProjectToolingSection('   ')).toBe('_(none detected)_');
  });
});

describe('renderPriorCritiqueSection', () => {
  it('renders the heading + the verbatim critique when provided', () => {
    const out = renderPriorCritiqueSection('## Completeness\n- step 3 verification missing');
    expect(out).toContain('## Prior Critique');
    expect(out).toContain('- step 3 verification missing');
    // The prose framing must reach the agent so they know this is a fix attempt.
    expect(out).toContain('Address each dimension');
  });

  it('returns the empty string when critique is undefined (turn 1 — no fix context yet)', () => {
    expect(renderPriorCritiqueSection(undefined)).toBe('');
  });

  it('returns the empty string when critique is whitespace-only', () => {
    expect(renderPriorCritiqueSection('   \n\t')).toBe('');
  });
});

describe('buildImplementPrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt with title, task name, project path, and progress file', async () => {
    const task = makeTaskWith({ name: 'export CSV', description: 'Add CSV export to the report endpoint.' });
    const result = await buildImplementPrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      verifyScript: 'npm run check',
      progressFile: '/tmp/ralph/sprint-1/progress.md',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain('# Task Execution Protocol');
    expect(result.value).toContain('# export CSV');
    expect(result.value).toContain(String(task.id));
    expect(result.value).toContain('/tmp/ralph/main-repo');
    expect(result.value).toContain('/tmp/ralph/sprint-1/progress.md');
    expect(result.value).toContain('## Description');
    expect(result.value).toContain('Add CSV export to the report endpoint.');
    expect(result.value).toContain('npm run check');
    // Default tooling fallback is rendered when projectTooling is omitted.
    expect(result.value).toContain('_(none detected)_');
    // No leftover placeholders.
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('omits the description block entirely when the task has no description', async () => {
    const task = makeTaskWith({ name: 'short task' });
    const result = await buildImplementPrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      progressFile: '/tmp/ralph/sprint-1/progress.md',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('## Description');
    // Sanity: the rest of the prompt still rendered.
    expect(result.value).toContain('# short task');
    expect(result.value).toContain('No verify script configured for this repo.');
  });

  it('renders the prior critique section verbatim on fix turns', async () => {
    const task = makeTaskWith({ name: 'export CSV' });
    const result = await buildImplementPrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      progressFile: '/tmp/ralph/sprint-1/progress.md',
      priorCritique: '## Completeness\n- step 3 verification missing\n- error handling untested',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('## Prior Critique');
    expect(result.value).toContain('step 3 verification missing');
    expect(result.value).toContain('error handling untested');
  });

  it('omits the prior critique section entirely on turn 1', async () => {
    const task = makeTaskWith({ name: 'export CSV' });
    const result = await buildImplementPrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      progressFile: '/tmp/ralph/sprint-1/progress.md',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('## Prior Critique');
  });
});

describe('implementPromptDef — validate-rejected paths', () => {
  it('rejects an empty taskName', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, implementPromptDef, {
      taskName: '   ',
      taskId: 'task-1',
      projectPath: '/tmp/ralph/main-repo',
      taskDescriptionSection: '',
      taskStepsSection: '',
      verificationCriteriaSection: '',
      verifyScriptSection: 'No verify script configured for this repo.',
      projectTooling: '_(none detected)_',
      progressFile: '/tmp/ralph/sprint-1/progress.md',
      priorCritiqueSection: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty progressFile', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, implementPromptDef, {
      taskName: 'export CSV',
      taskId: 'task-1',
      projectPath: '/tmp/ralph/main-repo',
      taskDescriptionSection: '',
      taskStepsSection: '',
      verificationCriteriaSection: '',
      verifyScriptSection: 'No verify script configured for this repo.',
      projectTooling: '_(none detected)_',
      progressFile: '',
      priorCritiqueSection: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
