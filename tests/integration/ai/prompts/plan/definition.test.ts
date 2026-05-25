import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { addTicket, type Sprint } from '@src/domain/entity/sprint.ts';
import { approveTicketRequirements } from '@src/domain/entity/ticket.ts';
import { makeDraftSprint, makePendingTicket, makeProject } from '@tests/fixtures/domain.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import {
  buildPlanPrompt,
  planPromptDef,
  renderApprovedTickets,
  renderExistingTasks,
  renderRepositories,
  renderSprintContext,
} from '@src/integration/ai/prompts/plan/definition.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());

const draftWithApproved = (count: number): Sprint => {
  let sprint: Sprint = makeDraftSprint();
  for (let i = 0; i < count; i++) {
    const pending = makePendingTicket({ title: `Ticket ${i + 1}` });
    const added = addTicket(sprint, pending);
    if (!added.ok) throw new Error('addTicket failed');
    const approved = approveTicketRequirements(added.value.tickets[i]!, '## requirements\n');
    if (!approved.ok) throw new Error('approveTicketRequirements failed');
    sprint = {
      ...added.value,
      tickets: added.value.tickets.map((t, idx) => (idx === i ? approved.value : t)),
    };
  }
  return sprint;
};

describe('planPromptDef — completeness', () => {
  it('every placeholder in plan.md is declared by the definition (parameters or partials)', async () => {
    const path = `${String(defaultTemplatesDir())}/plan/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = extractPlaceholders(template);

    const declared = new Set([
      ...Object.values(planPromptDef.parameters).map((p) => p.placeholder),
      ...Object.keys(planPromptDef.partials ?? {}),
    ]);
    for (const placeholder of placeholders) {
      expect(declared.has(placeholder), `template uses {{${placeholder}}} but the def doesn't declare it`).toBe(true);
    }
  });

  it('every placeholder declared by the definition exists in plan.md', async () => {
    const path = `${String(defaultTemplatesDir())}/plan/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = new Set(extractPlaceholders(template));

    for (const spec of Object.values(planPromptDef.parameters)) {
      expect(
        placeholders.has(spec.placeholder),
        `def declares {{${spec.placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
    for (const placeholder of Object.keys(planPromptDef.partials ?? {})) {
      expect(
        placeholders.has(placeholder),
        `def declares partial slot {{${placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
  });
});

describe('renderSprintContext', () => {
  it('renders sprint id, name, and project id', () => {
    const sprint = makeDraftSprint({ name: 'Q2 sprint' });
    const out = renderSprintContext(sprint);
    expect(out).toContain('# Sprint: Q2 sprint');
    expect(out).toContain(`Sprint ID: ${String(sprint.id)}`);
    expect(out).toContain(`Project ID: ${String(sprint.projectId)}`);
  });
});

describe('renderApprovedTickets', () => {
  it('lists approved tickets with id, title, and requirements body', () => {
    const sprint = draftWithApproved(2);
    const out = renderApprovedTickets(sprint);
    expect(out).toContain('Ticket 1');
    expect(out).toContain('Ticket 2');
    expect(out).toContain('## requirements');
  });

  it('emits a no-tickets placeholder when nothing has been approved', () => {
    expect(renderApprovedTickets(makeDraftSprint())).toContain('No approved tickets');
  });
});

describe('renderRepositories', () => {
  it('renders a markdown bullet list', () => {
    const project = makeProject();
    const out = renderRepositories(project);
    expect(out).toContain(String(project.repositories[0]?.path));
  });
});

describe('renderExistingTasks', () => {
  it('returns empty string for an empty task list (replan flow opt-out)', () => {
    expect(renderExistingTasks([])).toBe('');
  });

  it('renders heading + per-task block when given tasks', async () => {
    const { makeTodoTask } = await import('@tests/fixtures/domain.ts');
    const t1 = makeTodoTask({ name: 'Existing A' });
    const out = renderExistingTasks([t1]);
    expect(out).toContain('Existing Tasks (will be replaced)');
    expect(out).toContain('Existing A');
  });
});

const SAMPLE_CONTRACT_SECTION = '## Output contract\n\nWrite signals.json. (test fixture body.)';

describe('buildPlanPrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt for a fresh-plan input', async () => {
    const sprint = draftWithApproved(2);
    const result = await buildPlanPrompt(deps, {
      sprint,
      project: makeProject(),
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('<role>');
    expect(result.value).toContain('Approved tickets');
    expect(result.value).toContain('## Output contract');
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('includes the existing-tasks block in replan flows', async () => {
    const { makeTodoTask } = await import('@tests/fixtures/domain.ts');
    const sprint = draftWithApproved(1);
    const result = await buildPlanPrompt(deps, {
      sprint,
      project: makeProject(),
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      existingTasks: [makeTodoTask({ name: 'PrevTask' })],
      priorProgress: '',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('Existing Tasks (will be replaced)');
  });

  it('rejects an empty sprint-context via the spec validator', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, planPromptDef, {
      sprintContext: '   ',
      approvedTickets: 'x',
      repositories: 'x',
      schema: 'x',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty output-contract section via the spec validator', async () => {
    const sprint = draftWithApproved(1);
    const result = await buildPlanPrompt(deps, {
      sprint,
      project: makeProject(),
      outputContractSection: '',
      priorProgress: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
