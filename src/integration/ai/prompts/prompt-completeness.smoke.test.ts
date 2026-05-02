/**
 * Smoke test: every prompt the `PromptBuilderPort` produces contains
 * NO unresolved `{{PLACEHOLDER}}` tokens.
 *
 * Why this matters: the substitute helper is fail-soft — unknown
 * placeholders are left intact. A typo or missing field in the
 * adapter's substitution map silently emits the literal token to
 * Claude. Production bug seen on feature/new-ach: `buildPlanPrompt`
 * loaded the wrong template and emitted `{{CONTEXT}}`, `{{SCHEMA}}`,
 * `{{SIGNALS}}` etc verbatim. Claude received garbage and refused to
 * plan; the user found this with manual testing.
 *
 * This test loads the REAL templates from disk (not stubs) via
 * `FsTemplateLoader`, runs every builder method against minimal but
 * complete fixtures, and asserts the rendered string matches no
 * `/\{\{[A-Z_]+\}\}/` pattern. A drift here surfaces in CI before the
 * user sees it.
 *
 * Add a new builder method? Add a fixture + assertion below — that's
 * the explicit, friction-cost-low workflow.
 */
import { describe, expect, it } from 'vitest';

import { Project } from '@src/domain/entities/project.ts';
import { Repository } from '@src/domain/entities/repository.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { Task } from '@src/domain/entities/task.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';
import { TextPromptBuilderAdapter } from './prompt-builder-adapter.ts';
import { FileTemplateLoader, defaultTemplatesDir } from './template-loader.ts';

const T0 = IsoTimestamp.trustString('2026-04-29T12:00:00Z');

const UNRESOLVED_PLACEHOLDER_PATTERN = /\{\{[A-Z_]+\}\}/g;

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`unwrap: ${String(r.error)}`);
  return r.value;
}

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('bad path');
  return r.value;
}

function projectName(s = 'demo'): ProjectName {
  const r = ProjectName.parse(s);
  if (!r.ok) throw new Error('bad project name');
  return r.value;
}

function makeTicket(overrides: { link?: string; requirements?: string } = {}): Ticket {
  const id = TicketId.generate();
  const t = Ticket.create({
    id,
    title: 'Add login flow',
    description: 'Allow users to authenticate with email + password.',
    ...overrides,
  });
  return unwrap(t);
}

function makeSprint(): Sprint {
  const s = Sprint.create({
    name: 'Sprint A',
    slug: unwrap(Slug.parse('sprint-a')),
    now: T0,
    projectName: projectName(),
  });
  return unwrap(s);
}

function makeProject(): Project {
  const repo = unwrap(Repository.create({ path: path('/tmp/repo') }));
  const p = Project.create({ name: projectName(), displayName: 'Demo', repositories: [repo] });
  return unwrap(p);
}

function makeTask(): Task {
  const t = Task.create({
    name: 'wire-up-login-form',
    description: 'Implement the form and submit handler.',
    steps: ['Read AC', 'Build form', 'Wire submit', 'Run check gate'],
    verificationCriteria: ['Submit POSTs credentials', 'Errors render inline'],
    order: 1,
    ticketId: undefined,
    blockedBy: [],
    projectPath: path('/tmp/repo'),
  });
  return unwrap(t);
}

function assertNoUnresolvedPlaceholders(rendered: string, where: string): void {
  const matches = rendered.match(UNRESOLVED_PLACEHOLDER_PATTERN);
  if (matches !== null) {
    throw new Error(
      `${where}: rendered prompt contains unresolved placeholder(s): ${[...new Set(matches)].join(', ')}\n` +
        `This means the adapter forgot to fill a slot the template uses. Either fill the slot in the\n` +
        `adapter's substitution map or remove the placeholder from the template.`
    );
  }
}

describe('prompt completeness — no unresolved {{PLACEHOLDER}} in rendered output', () => {
  // FileTemplateLoader reads from the production templates dir, so these
  // tests exercise the same code path that runs against a real CLI.
  const loader = new FileTemplateLoader({ templatesDir: defaultTemplatesDir() });
  const adapter = new TextPromptBuilderAdapter(loader);

  it('refine — headless mode (no outputFilePath)', async () => {
    const ticket = makeTicket();
    const r = await adapter.buildRefinePrompt({ ticket });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildRefinePrompt(headless)');
  });

  it('refine — interactive mode (with outputFilePath)', async () => {
    const ticket = makeTicket({ link: 'https://github.com/owner/repo/issues/42' });
    const r = await adapter.buildRefinePrompt({
      ticket,
      outputFilePath: '/tmp/sprints/x/refinement/y/requirements.json',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildRefinePrompt(interactive)');
  });

  it('plan — auto / headless mode', async () => {
    const r = await adapter.buildPlanPrompt({ sprint: makeSprint(), existingTasks: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildPlanPrompt(auto)');
  });

  it('plan — interactive mode (with outputFilePath)', async () => {
    const r = await adapter.buildPlanPrompt({
      sprint: makeSprint(),
      existingTasks: [makeTask()],
      outputFilePath: '/tmp/sprints/x/planning/tasks.json',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildPlanPrompt(interactive)');
  });

  it('plan — interactive mode also includes the SCHEMA + CONTEXT bodies', async () => {
    const r = await adapter.buildPlanPrompt({
      sprint: makeSprint(),
      existingTasks: [],
      outputFilePath: '/tmp/sprints/x/planning/tasks.json',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Specific markers from each composed section — drift here flags the
    // bug we just shipped a fix for (template loading the wrong file).
    expect(r.value).toContain('PlannedTasks'); // SCHEMA
    expect(r.value).toContain('Sprint A'); // CONTEXT — sprint name
  });

  it('ideate — wraps idea + repos in the template', async () => {
    const sprint = makeSprint();
    const r = await adapter.buildIdeatePrompt({ sprint, ideaText: 'a new feature idea' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildIdeatePrompt');
  });

  it('execute — task + sprint context', async () => {
    const r = await adapter.buildExecutePrompt({ task: makeTask(), sprint: makeSprint() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildExecutePrompt');
  });

  it('evaluate — task + sprint, first round (no previous critique)', async () => {
    const r = await adapter.buildEvaluatePrompt({ task: makeTask(), sprint: makeSprint() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildEvaluatePrompt(round-1)');
  });

  it('evaluate — task + sprint, retry round (with previous critique)', async () => {
    const r = await adapter.buildEvaluatePrompt({
      task: makeTask(),
      sprint: makeSprint(),
      previousCritique: '## Round 1\nMissing AC for invalid email.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildEvaluatePrompt(round-2)');
  });

  it('feedback — sprint + free-form feedback text', async () => {
    const r = await adapter.buildFeedbackPrompt({ sprint: makeSprint(), feedbackText: 'tighten the error UX' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildFeedbackPrompt');
  });

  it('onboard — bootstrap mode (no prior context file)', async () => {
    const project = makeProject();
    const r = await adapter.buildOnboardPrompt({
      repoPath: path('/tmp/repo'),
      fileName: 'CLAUDE.md',
      mode: 'bootstrap',
      projectType: 'node',
      checkScriptSuggestion: 'pnpm test',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildOnboardPrompt(bootstrap)');
    void project;
  });

  it('onboard — adopt mode (existing prose preserved)', async () => {
    const r = await adapter.buildOnboardPrompt({
      repoPath: path('/tmp/repo'),
      fileName: 'CLAUDE.md',
      mode: 'adopt',
      projectType: 'node',
      existingAgentsMd: '# Project\n\nHand-authored notes.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildOnboardPrompt(adopt)');
  });

  it('onboard — update mode (harness-managed file present)', async () => {
    const r = await adapter.buildOnboardPrompt({
      repoPath: path('/tmp/repo'),
      fileName: '.github/copilot-instructions.md',
      mode: 'update',
      projectType: 'go',
      existingAgentsMd: '<!-- ralphctl onboard: 2026-04-29T12:00:00Z -->\n# Body',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildOnboardPrompt(update)');
  });
});
