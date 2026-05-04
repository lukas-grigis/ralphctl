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
    const r = await adapter.buildExecutePrompt({
      task: makeTask(),
      sprint: makeSprint(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildExecutePrompt');
    // Regression guard: task body (name + steps + verification criteria)
    // must render inline — the prompt itself IS the file the harness
    // writes to disk.
    expect(r.value).toContain('wire-up-login-form');
    expect(r.value).toContain('Build form');
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

  it('feedback — sprint + free-form feedback text + empty completed-tasks list', async () => {
    const r = await adapter.buildFeedbackPrompt({
      sprint: makeSprint(),
      feedbackText: 'tighten the error UX',
      completedTasks: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildFeedbackPrompt(no-tasks)');
  });

  it('feedback — sprint + completed tasks list (regression: each task name + path lands in the prompt)', async () => {
    const r = await adapter.buildFeedbackPrompt({
      sprint: makeSprint(),
      feedbackText: 'tighten the error UX',
      completedTasks: [makeTask()],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildFeedbackPrompt(with-tasks)');
    expect(r.value).toContain('wire-up-login-form');
    expect(r.value).toContain('/tmp/repo');
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

  // ─── additional completeness tests ───────────────────────────────────────

  it('refine — with pre-fetched issueContext text (distinct from bare-link rendering)', async () => {
    // The caller (chain leaf) may supply a pre-fetched issue body via
    // `issueContext`; the adapter wraps it in <context>…</context> rather
    // than falling back to the bare-link helper. Both code paths write to
    // the same {{ISSUE_CONTEXT}} slot — verify neither branch leaves a token.
    const ticket = makeTicket({ link: 'https://github.com/owner/repo/issues/99' });
    const r = await adapter.buildRefinePrompt({
      ticket,
      issueContext: '## Summary\n\nThe login button does nothing on mobile Safari.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildRefinePrompt(pre-fetched-issueContext)');
    expect(r.value).toContain('mobile Safari');
    expect(r.value).toContain('<context>');
  });

  it('execute — with checkScript supplied (renders fenced shell block, not "no script" text)', async () => {
    const r = await adapter.buildExecutePrompt({
      task: makeTask(),
      sprint: makeSprint(),
      checkScript: 'pnpm typecheck && pnpm test',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildExecutePrompt(with-checkScript)');
    expect(r.value).toContain('pnpm typecheck && pnpm test');
    expect(r.value).toContain('```sh');
  });

  it('execute — with sprint branch set (renders BRANCH_LINE inline)', async () => {
    // When a sprint has a branch, the execute prompt renders a "Branch: …"
    // line inside the task header. Verify the {{BRANCH_LINE}} slot is
    // always resolved regardless of whether branch is null or non-null.
    const base = makeSprint();
    const branched = base.setBranch('ralphctl/sprint-a');
    expect(branched.ok).toBe(true);
    if (!branched.ok) return;
    const r = await adapter.buildExecutePrompt({
      task: makeTask(),
      sprint: branched.value,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildExecutePrompt(with-branch)');
    expect(r.value).toContain('ralphctl/sprint-a');
  });

  it('execute — with checkRanAt populated (renders non-generic ENVIRONMENT_STATUS)', async () => {
    // When the harness has already run the check script for a repo, it
    // stamps `checkRanAt` on the sprint; the execute prompt renders the
    // timestamp instead of the generic "Not run." fallback.
    const base = makeSprint();
    const withCheck = base.recordCheckRun(path('/tmp/repo'), T0);
    const r = await adapter.buildExecutePrompt({
      task: makeTask(),
      sprint: withCheck,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildExecutePrompt(with-checkRanAt)');
    expect(r.value).toContain('2026-04-29T12:00:00Z');
    expect(r.value).not.toContain('Not run.');
  });

  it('evaluate — with evaluateWorkspaceDir supplied (renders contract-files section)', async () => {
    // The per-task chain mounts an evaluate workspace and passes its path
    // via `evaluateWorkspaceDir`. The template embeds a "Contract files"
    // section pointing the evaluator at the pre-staged artefacts. Verify
    // the {{EVALUATE_WORKSPACE}} slot resolves fully in this branch.
    const r = await adapter.buildEvaluatePrompt({
      task: makeTask(),
      sprint: makeSprint(),
      evaluateWorkspaceDir: '/tmp/sprints/sprint-a/execution/task-1/evaluate',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildEvaluatePrompt(with-workspace)');
    expect(r.value).toContain('Contract files');
    expect(r.value).toContain('/tmp/sprints/sprint-a/execution/task-1/evaluate');
  });

  it('evaluate — with doneCriteriaBullet supplied (renders per-task done-criteria section)', async () => {
    // The per-task chain reads the done-criteria.md bullet and passes it
    // to the evaluator prompt so the AI has an explicit, stable definition
    // of "done" for the current task. Verify the {{DONE_CRITERIA_SECTION}}
    // slot resolves fully and the section heading lands in the output.
    const bullet = '- **wire-up-login-form** (`tid-abc`) — Submit POSTs credentials; Errors render inline';
    const r = await adapter.buildEvaluatePrompt({
      task: makeTask(),
      sprint: makeSprint(),
      doneCriteriaBullet: bullet,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildEvaluatePrompt(with-doneCriteriaBullet)');
    expect(r.value).toContain('## Per-task done criteria');
    expect(r.value).toContain(bullet);
  });

  it('evaluate — without doneCriteriaBullet (DONE_CRITERIA_SECTION collapses to empty string)', async () => {
    // When no bullet is supplied (legacy sprint, no plan run, or standalone
    // evaluate without a workspace), the section must collapse cleanly —
    // no orphan heading, no literal placeholder.
    const r = await adapter.buildEvaluatePrompt({ task: makeTask(), sprint: makeSprint() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildEvaluatePrompt(no-doneCriteriaBullet)');
    expect(r.value).not.toContain('## Per-task done criteria');
    expect(r.value).not.toContain('{{DONE_CRITERIA_SECTION}}');
  });

  it('feedback — sprint without a branch (BRANCH_SECTION collapses to empty string)', async () => {
    // `makeSprint()` creates a sprint with `branch: null`. The adapter
    // renders an empty `BRANCH_SECTION` in that case. Verify the slot is
    // still fully resolved (no literal {{BRANCH_SECTION}} survives).
    const sprint = makeSprint(); // branch is null
    const r = await adapter.buildFeedbackPrompt({
      sprint,
      feedbackText: 'improve error messages',
      completedTasks: [makeTask()],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildFeedbackPrompt(no-branch)');
    // The branch section must not bleed a literal placeholder or an empty
    // "Branch:" header into the rendered prompt.
    expect(r.value).not.toContain('{{BRANCH_SECTION}}');
  });

  it('plan — sprint with affectedRepositories set (repos appear in CONTEXT block)', async () => {
    // `renderPlanContext` emits a "## Repositories" block only when
    // `sprint.affectedRepositories` is non-empty. Verify the {{CONTEXT}}
    // slot resolves fully in that branch and the repo path lands in the output.
    const base = makeSprint();
    const withRepos = base.setAffectedRepositories([path('/tmp/repo')]);
    expect(withRepos.ok).toBe(true);
    if (!withRepos.ok) return;
    const r = await adapter.buildPlanPrompt({
      sprint: withRepos.value,
      existingTasks: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildPlanPrompt(with-affectedRepositories)');
    expect(r.value).toContain('/tmp/repo');
  });

  it('ideate — sprint with affectedRepositories set (repos appear in REPOSITORIES block)', async () => {
    // `renderRepositories` emits a bulleted list only when
    // `sprint.affectedRepositories` is non-empty; ideate uses the same
    // helper. Verify the {{REPOSITORIES}} slot resolves and the path lands
    // in the prompt.
    const base = makeSprint();
    const withRepos = base.setAffectedRepositories([path('/tmp/repo')]);
    expect(withRepos.ok).toBe(true);
    if (!withRepos.ok) return;
    const r = await adapter.buildIdeatePrompt({
      sprint: withRepos.value,
      ideaText: 'add a new dashboard widget',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertNoUnresolvedPlaceholders(r.value, 'buildIdeatePrompt(with-affectedRepositories)');
    expect(r.value).toContain('/tmp/repo');
    expect(r.value).not.toContain('(no repositories selected)');
  });
});
