import { describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import { Task } from '@src/domain/entities/task.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';
import { TextPromptBuilderAdapter, TEMPLATE_NAMES } from './prompt-builder-adapter.ts';
import type { TemplateLoader } from './template-loader.ts';
import { FileTemplateLoader } from './template-loader.ts';

// ───────────────────────── helpers ─────────────────────────

function projectName(): ProjectName {
  const r = ProjectName.parse('demo-project');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}
function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}
function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;

function makeTicket(overrides: { title?: string; description?: string; link?: string } = {}): Ticket {
  const r = Ticket.create({
    title: overrides.title ?? 'Add login flow',
    description: overrides.description ?? 'Implement OAuth2 login',
    link: overrides.link,
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function makeSprint(tickets: readonly Ticket[] = []): Sprint {
  const r0 = Sprint.create({
    name: 'Sprint Alpha',
    slug: slug('sprint-alpha'),
    now: T0,
    projectName: projectName(),
  });
  if (!r0.ok) throw new Error('precondition failed');
  let s = r0.value;
  for (const t of tickets) {
    const next = s.addTicket(t);
    if (!next.ok) throw new Error('precondition failed');
    s = next.value;
  }
  return s;
}

function makeTask(): Task {
  const r = Task.create({
    name: 'Wire OAuth callback',
    description: 'Hook the callback handler into the router',
    steps: ['Read existing router', 'Add the route', 'Wire it up'],
    verificationCriteria: ['Login redirects work', 'Tests pass'],
    order: 1,
    projectPath: path('/tmp/demo-repo'),
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

class StubTemplateLoader implements TemplateLoader {
  readonly calls: string[] = [];
  constructor(private readonly templates: Readonly<Record<string, string>>) {}
  load(name: string): Promise<Result<string, StorageError>> {
    this.calls.push(name);
    const body = this.templates[name];
    if (body === undefined) {
      return Promise.resolve(
        Result.error(new StorageError({ subCode: 'io', message: `unknown template ${name}`, path: `${name}.md` }))
      );
    }
    return Promise.resolve(Result.ok(body));
  }
}

// ───────────────────────── template-name mapping ─────────────────────────

describe('TEMPLATE_NAMES', () => {
  it('maps each port method to the expected .md basename', () => {
    expect(TEMPLATE_NAMES.refine).toBe('ticket-refine');
    expect(TEMPLATE_NAMES.plan).toBe('plan-common');
    expect(TEMPLATE_NAMES.ideate).toBe('ideate');
    expect(TEMPLATE_NAMES.execute).toBe('task-execution');
    expect(TEMPLATE_NAMES.evaluate).toBe('task-evaluation');
    expect(TEMPLATE_NAMES.feedback).toBe('sprint-feedback');
    expect(TEMPLATE_NAMES.onboard).toBe('repo-onboard');
  });
});

// ───────────────────────── per-method builders (with stub loader) ─────────────────────────

describe('TextPromptBuilderAdapter — refine', () => {
  it('loads the ticket-refine template and substitutes ticket marker', async () => {
    const loader = new StubTemplateLoader({
      'ticket-refine': 'BEGIN\n{{TICKET}}\nEND',
    });
    const adapter: PromptBuilderPort = new TextPromptBuilderAdapter(loader);
    const ticket = makeTicket({ title: 'Add login flow' });

    const r = await adapter.buildRefinePrompt({ ticket });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(loader.calls).toStrictEqual(['ticket-refine']);
    expect(r.value).toContain('Add login flow');
    expect(r.value).toContain(`**ID:** ${ticket.id}`);
    expect(r.value).not.toContain('{{TICKET}}');
  });

  it('emits an empty ISSUE_CONTEXT when the ticket has no link', async () => {
    const loader = new StubTemplateLoader({
      'ticket-refine': '{{ISSUE_CONTEXT}}',
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const r = await adapter.buildRefinePrompt({ ticket: makeTicket() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('');
  });

  it('substitutes the JSON schema into SCHEMA so Claude has a format contract', async () => {
    // The ticket-refine template embeds the JSON schema the AI is
    // expected to write against. Without this Claude invents a shape
    // and the parser falls through to the raw-body fallback.
    const loader = new StubTemplateLoader({
      'ticket-refine': '<<<{{SCHEMA}}>>>',
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const r = await adapter.buildRefinePrompt({ ticket: makeTicket() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain('RefinedRequirements');
    expect(r.value).toContain('"requirements"');
  });

  it('wraps an upstream link in <context>...</context> when present', async () => {
    const loader = new StubTemplateLoader({
      'ticket-refine': '<<<{{ISSUE_CONTEXT}}>>>',
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const r = await adapter.buildRefinePrompt({
      ticket: makeTicket({ link: 'https://example.com/issues/42' }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toContain('<context>');
      expect(r.value).toContain('https://example.com/issues/42');
    }
  });

  it('propagates a loader StorageError verbatim', async () => {
    const loader = new StubTemplateLoader({});
    const adapter = new TextPromptBuilderAdapter(loader);
    const r = await adapter.buildRefinePrompt({ ticket: makeTicket() });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(StorageError);
      expect(r.error.subCode).toBe('io');
    }
  });
});

describe('TextPromptBuilderAdapter — plan', () => {
  it('routes to plan-auto template when outputFilePath is omitted (headless mode)', async () => {
    // The plan builder loads five partials AND the outer template; stub
    // every one. The minimal-marker pattern is enough — we just want to
    // see SCHEMA / CONTEXT / COMMON land in the output.
    const loader = new StubTemplateLoader({
      'plan-auto': 'AUTO|context={{CONTEXT}}|schema={{SCHEMA}}|common={{COMMON}}',
      'plan-interactive': 'INTERACTIVE|out={{OUTPUT_FILE}}',
      'plan-common': 'COMMON|tooling={{PROJECT_TOOLING}}|ex={{PLAN_COMMON_EXAMPLES}}|gate={{CHECK_GATE_EXAMPLE}}',
      'plan-common-examples': 'EXAMPLES',
      'harness-context': 'HARNESS',
      'validation-checklist': 'VALIDATION',
      'signals-planning': 'SIGNALS',
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const sprint = makeSprint([makeTicket({ title: 'first' })]);

    const r = await adapter.buildPlanPrompt({ sprint, existingTasks: [makeTask()] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain('AUTO|');
    expect(r.value).toContain('Sprint Alpha'); // CONTEXT block carries the sprint name
    expect(r.value).toContain('PlannedTasks'); // SCHEMA block carries the schema title
    expect(r.value).toContain('COMMON|tooling=|ex=EXAMPLES|gate='); // partial pre-substituted
  });

  it('routes to plan-interactive template when outputFilePath is provided', async () => {
    const loader = new StubTemplateLoader({
      'plan-auto': 'AUTO',
      'plan-interactive': 'INTERACTIVE|out={{OUTPUT_FILE}}|schema={{SCHEMA}}',
      'plan-common': 'C',
      'plan-common-examples': 'E',
      'harness-context': 'H',
      'validation-checklist': 'V',
      'signals-planning': 'S',
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const sprint = makeSprint([makeTicket({ title: 'first' })]);

    const r = await adapter.buildPlanPrompt({
      sprint,
      existingTasks: [],
      outputFilePath: '/tmp/sprints/x/planning/tasks.json',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain('INTERACTIVE|');
    expect(r.value).toContain('out=/tmp/sprints/x/planning/tasks.json');
    expect(r.value).toContain('PlannedTasks');
  });

  it('returns the loader error when a planner partial is missing', async () => {
    const loader = new StubTemplateLoader({
      'plan-auto': 'AUTO',
      // 'plan-common' missing on purpose
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const sprint = makeSprint([makeTicket({ title: 'first' })]);

    const r = await adapter.buildPlanPrompt({ sprint, existingTasks: [] });
    expect(r.ok).toBe(false);
  });
});

describe('TextPromptBuilderAdapter — ideate', () => {
  it('substitutes the idea text into the IDEA_DESCRIPTION slot', async () => {
    const loader = new StubTemplateLoader({
      ideate: '## {{IDEA_TITLE}}\n{{IDEA_DESCRIPTION}}\n{{REPOSITORIES}}',
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const sprint = makeSprint([makeTicket()]);
    const r = await adapter.buildIdeatePrompt({ sprint, ideaText: 'a brand new idea' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toContain('Sprint Alpha');
      expect(r.value).toContain('a brand new idea');
      expect(r.value).toContain('(no repositories selected)');
    }
  });
});

describe('TextPromptBuilderAdapter — execute', () => {
  it('renders an empty PROJECT_TOOLING slot when the task path has no detectable tooling', async () => {
    // /tmp/demo-repo doesn't exist on disk → detectProjectTooling
    // returns the empty shape and the placeholder collapses cleanly.
    const loader = new StubTemplateLoader({
      'task-execution': 'BEGIN:{{PROJECT_TOOLING}}:END',
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const sprint = makeSprint();
    const task = makeTask();
    const r = await adapter.buildExecutePrompt({ task, sprint });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe('BEGIN::END');
    }
  });
});

describe('TextPromptBuilderAdapter — evaluate', () => {
  it('renders task name + verification criteria + previous critique', async () => {
    const loader = new StubTemplateLoader({
      'task-evaluation':
        'task: {{TASK_NAME}}\n{{TASK_DESCRIPTION_SECTION}}\n{{VERIFICATION_CRITERIA_SECTION}}\nproject: {{PROJECT_PATH}}\n{{CHECK_SCRIPT_SECTION}}',
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const sprint = makeSprint();
    const task = makeTask();
    const r = await adapter.buildEvaluatePrompt({ task, sprint, previousCritique: 'be more rigorous' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toContain('task: Wire OAuth callback');
      expect(r.value).toContain('Hook the callback handler');
      expect(r.value).toContain('Login redirects work');
      expect(r.value).toContain('/tmp/demo-repo');
      expect(r.value).toContain('be more rigorous');
    }
  });

  it('omits the previous-critique section when none is provided', async () => {
    const loader = new StubTemplateLoader({
      'task-evaluation': 'crit:{{CHECK_SCRIPT_SECTION}}:end',
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const r = await adapter.buildEvaluatePrompt({ task: makeTask(), sprint: makeSprint() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('crit::end');
  });
});

describe('TextPromptBuilderAdapter — onboard', () => {
  it('substitutes every onboarding placeholder', async () => {
    const loader = new StubTemplateLoader({
      'repo-onboard':
        'repo:{{REPO_PATH}}|file:{{FILE_NAME}}|mode:{{MODE}}|type:{{PROJECT_TYPE}}|hint:{{CHECK_SCRIPT_SUGGESTION}}|prior:{{EXISTING_AGENTS_MD}}',
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const r = await adapter.buildOnboardPrompt({
      repoPath: path('/tmp/demo-repo'),
      fileName: 'CLAUDE.md',
      mode: 'bootstrap',
      projectType: 'node',
      checkScriptSuggestion: 'pnpm test',
      existingAgentsMd: '# Old\n\nbody',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(loader.calls).toStrictEqual(['repo-onboard']);
    expect(r.value).toContain('repo:/tmp/demo-repo');
    expect(r.value).toContain('file:CLAUDE.md');
    expect(r.value).toContain('mode:bootstrap');
    expect(r.value).toContain('type:node');
    expect(r.value).toContain('hint:pnpm test');
    expect(r.value).toContain('# Old');
    expect(r.value).toContain('```markdown');
  });

  it('renders empty CHECK_SCRIPT_SUGGESTION + EXISTING_AGENTS_MD when omitted', async () => {
    const loader = new StubTemplateLoader({
      'repo-onboard': '<<{{CHECK_SCRIPT_SUGGESTION}}>>--<<{{EXISTING_AGENTS_MD}}>>',
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const r = await adapter.buildOnboardPrompt({
      repoPath: path('/tmp/demo-repo'),
      fileName: '.github/copilot-instructions.md',
      mode: 'adopt',
      projectType: 'unknown',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('<<>>--<<>>');
  });

  it('propagates loader StorageError verbatim', async () => {
    const loader = new StubTemplateLoader({});
    const adapter = new TextPromptBuilderAdapter(loader);
    const r = await adapter.buildOnboardPrompt({
      repoPath: path('/tmp/demo-repo'),
      fileName: 'CLAUDE.md',
      mode: 'bootstrap',
      projectType: 'node',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(StorageError);
  });

  it('integration: real repo-onboard template renders the four-artefact contract', async () => {
    const loader = new FileTemplateLoader();
    const adapter = new TextPromptBuilderAdapter(loader);
    const r = await adapter.buildOnboardPrompt({
      repoPath: path('/tmp/demo-repo'),
      fileName: 'CLAUDE.md',
      mode: 'bootstrap',
      projectType: 'node',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain('Repository Onboarding Protocol');
    expect(r.value).toContain('<agents-md>');
    expect(r.value).toContain('<setup-script>');
    expect(r.value).toContain('<verify-script>');
    expect(r.value).toContain('<skill-suggestions>');
    // Every placeholder should be substituted (no `{{…}}` left behind).
    expect(r.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe('TextPromptBuilderAdapter — feedback', () => {
  it('renders sprint name + branch + feedback text', async () => {
    const loader = new StubTemplateLoader({
      'sprint-feedback': 'Sprint: {{SPRINT_NAME}}\n{{BRANCH_SECTION}}\nNote: {{FEEDBACK}}',
    });
    const adapter = new TextPromptBuilderAdapter(loader);
    const base = makeSprint();
    const branched = base.setBranch('ralphctl/foo');
    if (!branched.ok) throw new Error('precondition failed');
    const sprint = branched.value;
    const r = await adapter.buildFeedbackPrompt({ sprint, feedbackText: 'add retries' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toContain('Sprint: Sprint Alpha');
      expect(r.value).toContain('Branch:** ralphctl/foo');
      expect(r.value).toContain('Note: add retries');
    }
  });
});

// ───────────────────────── integration with real templates ─────────────────────────

describe('TextPromptBuilderAdapter — integration with bundled templates', () => {
  it('loads every template referenced by TEMPLATE_NAMES from the dev tree', async () => {
    const loader = new FileTemplateLoader();
    const adapter = new TextPromptBuilderAdapter(loader);

    const refine = await adapter.buildRefinePrompt({ ticket: makeTicket({ title: 'XYZ_REFINE_MARKER' }) });
    expect(refine.ok).toBe(true);
    if (refine.ok) expect(refine.value).toContain('XYZ_REFINE_MARKER');

    const plan = await adapter.buildPlanPrompt({ sprint: makeSprint([makeTicket()]), existingTasks: [] });
    expect(plan.ok).toBe(true);
    // Anchor on the template body itself — sprint name no longer leaks
    // into the plan prompt (PROJECT_TOOLING is for tooling, not sprint
    // metadata, after the cleanup).
    if (plan.ok) expect(plan.value).toContain('Project Resources');

    const ideate = await adapter.buildIdeatePrompt({
      sprint: makeSprint([makeTicket()]),
      ideaText: 'XYZ_IDEATE_MARKER',
    });
    expect(ideate.ok).toBe(true);
    if (ideate.ok) expect(ideate.value).toContain('XYZ_IDEATE_MARKER');

    const exec = await adapter.buildExecutePrompt({ task: makeTask(), sprint: makeSprint() });
    expect(exec.ok).toBe(true);
    // Task name is no longer projected into the prompt body — anchor on
    // the template's own preamble instead.
    if (exec.ok) expect(exec.value).toContain('Task Execution Protocol');

    const evalR = await adapter.buildEvaluatePrompt({ task: makeTask(), sprint: makeSprint() });
    expect(evalR.ok).toBe(true);
    // TASK_NAME is wired into the evaluator template heading directly.
    if (evalR.ok) expect(evalR.value).toContain('Wire OAuth callback');

    const fb = await adapter.buildFeedbackPrompt({ sprint: makeSprint(), feedbackText: 'XYZ_FEEDBACK_MARKER' });
    expect(fb.ok).toBe(true);
    if (fb.ok) expect(fb.value).toContain('XYZ_FEEDBACK_MARKER');
  });
});
