import { describe, expect, it } from 'vitest';
import {
  buildAutoPrompt,
  buildEvaluationResumePrompt,
  buildEvaluatorPrompt,
  buildIdeateAutoPrompt,
  buildIdeatePrompt,
  buildInteractivePrompt,
  buildTaskExecutionPrompt,
  buildTicketRefinePrompt,
  loadPartial,
} from './loader.ts';

// ---------------------------------------------------------------------------
// Invariant — unreplaced {{TOKEN}} placeholders
// ---------------------------------------------------------------------------
// composePrompt() (src/ai/prompts/index.ts) throws synchronously when any
// {{…}} placeholder remains after substitution. Every builder test below that
// calls a build*() function therefore doubles as an assertion of complete key
// coverage: a missing substitution surfaces as a thrown Error, not as silent
// empty output. Do NOT re-add per-builder "no unreplaced tokens" assertions —
// they would be redundant with the composePrompt contract.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Marker substrings unique to each shared partial — used to assert inlining. */
const PARTIAL_MARKERS = {
  harnessContext: 'automatically compacted',
  validation: 'Pre-Output Validation',
  signalsTask: '<task-verified>',
  signalsPlanning: '<planning-blocked>',
  signalsEvaluation: '<evaluation-passed>',
  planCommonExamples: 'Good Dependency Graph',
} as const;

// ---------------------------------------------------------------------------
// buildInteractivePrompt
// ---------------------------------------------------------------------------

describe('buildInteractivePrompt', () => {
  const context = '## Sprint Context\n\nTicket: Add login';
  const outputFile = '/tmp/sprint/planning/tasks.json';
  const schema = '{"type":"array","items":{}}';

  it('produces non-empty output', () => {
    const result = buildInteractivePrompt(context, outputFile, schema, '');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the context in the output', () => {
    const result = buildInteractivePrompt(context, outputFile, schema, '');
    expect(result).toContain('Ticket: Add login');
  });

  it('includes the output file path', () => {
    const result = buildInteractivePrompt(context, outputFile, schema, '');
    expect(result).toContain(outputFile);
  });

  it('includes the JSON schema', () => {
    const result = buildInteractivePrompt(context, outputFile, schema, '');
    expect(result).toContain(schema);
  });

  it('inlines the plan-common template content', () => {
    const result = buildInteractivePrompt(context, outputFile, schema, '');
    // plan-common contains sections about "What Makes a Great Task" or "Dependency Graph"
    expect(result).toMatch(/What Makes a Great Task|Dependency Graph/i);
  });

  it('inlines the project tooling section when provided', () => {
    const tooling = '## Project Tooling\n\n- agent: my-reviewer-agent';
    const result = buildInteractivePrompt(context, outputFile, schema, tooling);
    expect(result).toContain('## Project Tooling');
    expect(result).toContain('my-reviewer-agent');
  });
});

// ---------------------------------------------------------------------------
// buildAutoPrompt
// ---------------------------------------------------------------------------

describe('buildAutoPrompt', () => {
  const context = '## Sprint Context\n\nTicket: Migrate database';
  const schema = '{"type":"array"}';

  it('produces non-empty output', () => {
    const result = buildAutoPrompt(context, schema, '');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the context in the output', () => {
    const result = buildAutoPrompt(context, schema, '');
    expect(result).toContain('Ticket: Migrate database');
  });

  it('includes the JSON schema', () => {
    const result = buildAutoPrompt(context, schema, '');
    expect(result).toContain(schema);
  });

  it('inlines plan-common content', () => {
    const result = buildAutoPrompt(context, schema, '');
    expect(result).toMatch(/What Makes a Great Task|Dependency Graph/i);
  });

  it('does not include OUTPUT_FILE (auto mode writes directly)', () => {
    // Auto mode outputs JSON directly — there is no output file placeholder
    const result = buildAutoPrompt(context, schema, '');
    expect(result).not.toContain('{{OUTPUT_FILE}}');
  });

  it('inlines the project tooling section when provided', () => {
    const tooling = '## Project Tooling\n\n- agent: my-reviewer-agent';
    const result = buildAutoPrompt(context, schema, tooling);
    expect(result).toContain('## Project Tooling');
    expect(result).toContain('my-reviewer-agent');
  });
});

// ---------------------------------------------------------------------------
// buildTaskExecutionPrompt
// ---------------------------------------------------------------------------

describe('buildTaskExecutionPrompt', () => {
  const progressFile = '/tmp/sprint/progress.md';
  const contextFile = 'task-context.md';

  it('produces non-empty output', () => {
    const result = buildTaskExecutionPrompt(progressFile, false, contextFile);
    expect(result.length).toBeGreaterThan(0);
  });

  it('replaces all {{PROGRESS_FILE}} tokens', () => {
    const result = buildTaskExecutionPrompt(progressFile, false, contextFile);
    expect(result).toContain(progressFile);
    expect(result).not.toContain('{{PROGRESS_FILE}}');
  });

  it('replaces all {{CONTEXT_FILE}} tokens (uses replaceAll)', () => {
    const result = buildTaskExecutionPrompt(progressFile, false, contextFile);
    expect(result).not.toContain('{{CONTEXT_FILE}}');
  });

  it('includes the progress file path', () => {
    const result = buildTaskExecutionPrompt(progressFile, false, contextFile);
    expect(result).toContain(progressFile);
  });

  it('includes the context file name (replaces all occurrences)', () => {
    const result = buildTaskExecutionPrompt(progressFile, false, contextFile);
    // The template uses {{CONTEXT_FILE}} multiple times — all should be replaced
    expect(result).toContain(contextFile);
    expect(result).not.toContain('{{CONTEXT_FILE}}');
  });

  describe('noCommit = false (with commit)', () => {
    it('includes commit step instruction', () => {
      const result = buildTaskExecutionPrompt(progressFile, false, contextFile);
      expect(result).toContain('git commit');
    });

    it('includes commit constraint text', () => {
      const result = buildTaskExecutionPrompt(progressFile, false, contextFile);
      expect(result).toContain('Must commit');
    });

    it('renders Must commit as a peer constraint bullet at column 0, not a nested sub-bullet', () => {
      // Regression guard for a Prettier-reflow bug: when {{COMMIT_CONSTRAINT}}
      // sat indented under the preceding bullet's continuation, the rendered
      // "- **Must commit**" read as a sub-bullet of "Leave CONTEXT_FILE alone".
      // The placeholder must live at column 0 so the bullet is a sibling.
      const result = buildTaskExecutionPrompt(progressFile, false, contextFile);
      // Column-0 match (no leading whitespace) — the authoritative assertion.
      expect(result).toMatch(/^- \*\*Must commit\*\*/m);
      // And the indented form must not appear anywhere.
      expect(result).not.toMatch(/^[ \t]+- \*\*Must commit\*\*/m);
    });

    it('places the closing </constraints> tag at column 0 (not indented under a bullet)', () => {
      const result = buildTaskExecutionPrompt(progressFile, false, contextFile);
      expect(result).toMatch(/^<\/constraints>/m);
    });
  });

  describe('noCommit = true', () => {
    it('omits git commit step instruction', () => {
      const result = buildTaskExecutionPrompt(progressFile, true, contextFile);
      // The commit step should be empty — commit instruction block is absent
      // We verify the "Before continuing" commit reminder is not in the output
      expect(result).not.toContain('Before continuing');
    });

    it('omits commit constraint', () => {
      const result = buildTaskExecutionPrompt(progressFile, true, contextFile);
      expect(result).not.toContain('Must commit');
    });
  });

  it('includes core task execution signals', () => {
    const result = buildTaskExecutionPrompt(progressFile, false, contextFile);
    expect(result).toContain('task-complete');
    expect(result).toContain('task-blocked');
    expect(result).toContain('task-verified');
  });
});

// ---------------------------------------------------------------------------
// buildTicketRefinePrompt
// ---------------------------------------------------------------------------

describe('buildTicketRefinePrompt', () => {
  const ticket = '## Ticket\n\nTitle: Add export feature';
  const outputFile = '/tmp/refinement/requirements.json';
  const schema = '{"type":"array","items":{"properties":{"ref":{"type":"string"}}}}';

  it('produces non-empty output', () => {
    const result = buildTicketRefinePrompt(ticket, outputFile, schema);
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the ticket content', () => {
    const result = buildTicketRefinePrompt(ticket, outputFile, schema);
    expect(result).toContain('Add export feature');
  });

  it('includes the output file path', () => {
    const result = buildTicketRefinePrompt(ticket, outputFile, schema);
    expect(result).toContain(outputFile);
  });

  it('includes the JSON schema', () => {
    const result = buildTicketRefinePrompt(ticket, outputFile, schema);
    expect(result).toContain(schema);
  });

  it('includes issue context when provided', () => {
    const issueContext = '## GitHub Issue\n\nContext from GitHub issue #123';
    const result = buildTicketRefinePrompt(ticket, outputFile, schema, issueContext);
    expect(result).toContain(issueContext);
  });

  it('issue context is empty string when not provided', () => {
    // When issueContext defaults to '' the {{ISSUE_CONTEXT}} slot is replaced with nothing
    const withIssue = buildTicketRefinePrompt(ticket, outputFile, schema, 'some context');
    const withoutIssue = buildTicketRefinePrompt(ticket, outputFile, schema);
    expect(withoutIssue.length).toBeLessThan(withIssue.length);
  });
});

// ---------------------------------------------------------------------------
// buildIdeatePrompt (interactive ideate)
// ---------------------------------------------------------------------------

describe('buildIdeatePrompt', () => {
  const ideaTitle = 'Dark mode support';
  const ideaDescription = 'Allow users to switch between light and dark themes.';
  const projectName = 'frontend-app';
  const repositories = '/Users/dev/frontend-app';
  const outputFile = '/tmp/sprint/planning/tasks.json';
  const schema = '{"type":"object"}';

  it('produces non-empty output', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema, '');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the idea title', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema, '');
    expect(result).toContain(ideaTitle);
  });

  it('includes the idea description', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema, '');
    expect(result).toContain(ideaDescription);
  });

  it('includes the project name', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema, '');
    expect(result).toContain(projectName);
  });

  it('includes the repositories', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema, '');
    expect(result).toContain(repositories);
  });

  it('includes the output file path', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema, '');
    expect(result).toContain(outputFile);
  });

  it('includes the JSON schema', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema, '');
    expect(result).toContain(schema);
  });

  it('inlines plan-common content', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema, '');
    expect(result).toMatch(/What Makes a Great Task|Dependency Graph/i);
  });

  it('inlines the project tooling section when provided', () => {
    const tooling = '## Project Tooling\n\n- agent: my-reviewer-agent';
    const result = buildIdeatePrompt(
      ideaTitle,
      ideaDescription,
      projectName,
      repositories,
      outputFile,
      schema,
      tooling
    );
    expect(result).toContain('## Project Tooling');
    expect(result).toContain('my-reviewer-agent');
  });
});

// ---------------------------------------------------------------------------
// buildIdeateAutoPrompt (headless ideate)
// ---------------------------------------------------------------------------

describe('buildIdeateAutoPrompt', () => {
  const ideaTitle = 'Webhook notifications';
  const ideaDescription = 'Send HTTP webhooks when tasks change status.';
  const projectName = 'backend-api';
  const repositories = '/Users/dev/backend-api';
  const schema = '{"type":"object","properties":{"tasks":{"type":"array"}}}';

  it('produces non-empty output', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema, '');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the idea title', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema, '');
    expect(result).toContain(ideaTitle);
  });

  it('includes the idea description', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema, '');
    expect(result).toContain(ideaDescription);
  });

  it('includes the project name', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema, '');
    expect(result).toContain(projectName);
  });

  it('includes the repositories', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema, '');
    expect(result).toContain(repositories);
  });

  it('includes the JSON schema', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema, '');
    expect(result).toContain(schema);
  });

  it('inlines plan-common content', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema, '');
    expect(result).toMatch(/What Makes a Great Task|Dependency Graph/i);
  });

  it('does not include OUTPUT_FILE (auto mode outputs directly)', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema, '');
    expect(result).not.toContain('{{OUTPUT_FILE}}');
  });

  it('inlines the project tooling section when provided', () => {
    const tooling = '## Project Tooling\n\n- agent: my-reviewer-agent';
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema, tooling);
    expect(result).toContain('## Project Tooling');
    expect(result).toContain('my-reviewer-agent');
  });
});

// ---------------------------------------------------------------------------
// buildEvaluatorPrompt
// ---------------------------------------------------------------------------

describe('buildEvaluatorPrompt', () => {
  const baseCtx = {
    taskName: 'Add date filter',
    taskDescription: 'Filter export endpoint by date',
    taskSteps: ['Add Zod schema', 'Wire controller'],
    verificationCriteria: ['Returns 400 for invalid', 'Returns filtered results for valid'],
    projectPath: '/tmp/proj',
    checkScriptSection: null,
    projectToolingSection: '',
    extraDimensions: [] as string[],
  };

  it('renders verification criteria as a bullet list', () => {
    const result = buildEvaluatorPrompt(baseCtx);
    expect(result).toContain('Returns 400 for invalid');
    expect(result).toContain('Returns filtered results for valid');
  });

  it('inlines the project tooling section when provided', () => {
    const tooling = '## Project Tooling\n\n- agent: reviewer';
    const result = buildEvaluatorPrompt({ ...baseCtx, projectToolingSection: tooling });
    expect(result).toContain('## Project Tooling');
    expect(result).toContain('agent: reviewer');
  });

  it('inlines the check script section when provided', () => {
    const result = buildEvaluatorPrompt({ ...baseCtx, checkScriptSection: '## Check Script\n\nRun pnpm test' });
    expect(result).toContain('Run pnpm test');
  });

  describe('extraDimensions', () => {
    it('renders only the four floor dimensions when extras is empty', () => {
      const result = buildEvaluatorPrompt(baseCtx);
      expect(result).toContain('<dimension name="Correctness" floor="true">');
      expect(result).toContain('<dimension name="Completeness" floor="true">');
      expect(result).toContain('<dimension name="Safety" floor="true">');
      expect(result).toContain('<dimension name="Consistency" floor="true">');
      // No floor="false" (planner-emitted) dimension when no extras supplied.
      expect(result).not.toContain('floor="false"');
    });

    it('renders an additional dimension block per extra entry', () => {
      const result = buildEvaluatorPrompt({ ...baseCtx, extraDimensions: ['Performance'] });
      expect(result).toContain('<dimension name="Performance" floor="false">');
      // The four floor dimensions still come first.
      expect(result).toContain('<dimension name="Consistency" floor="true">');
      // Extra appears in the Pass Bar list and the Assessment templates.
      expect(result).toContain('- **Performance**');
      expect(result).toMatch(/\*\*Performance\*\*: PASS — \[one-line finding]/);
      expect(result).toMatch(/\*\*Performance\*\*: PASS\/FAIL — \[one-line finding]/);
    });

    it('emits one dimension tag per extra entry', () => {
      const result = buildEvaluatorPrompt({
        ...baseCtx,
        extraDimensions: ['Performance', 'Accessibility', 'MigrationSafety'],
      });
      expect(result).toContain('<dimension name="Performance" floor="false">');
      expect(result).toContain('<dimension name="Accessibility" floor="false">');
      expect(result).toContain('<dimension name="MigrationSafety" floor="false">');
    });

    it('leaves no unrendered placeholders when extras is empty', () => {
      const result = buildEvaluatorPrompt(baseCtx);
      expect(result).not.toMatch(/\{\{EXTRA_DIMENSIONS/);
    });
  });
});

// ---------------------------------------------------------------------------
// buildEvaluationResumePrompt
// ---------------------------------------------------------------------------

describe('buildEvaluationResumePrompt', () => {
  it('embeds the critique into the template', () => {
    const result = buildEvaluationResumePrompt({ critique: 'Bug at src/foo.ts:42', needsCommit: false });
    expect(result).toContain('Bug at src/foo.ts:42');
  });

  it('includes a commit instruction when needsCommit is true', () => {
    const result = buildEvaluationResumePrompt({ critique: 'x', needsCommit: true });
    expect(result).toContain('commit the fix');
  });

  it('omits the commit instruction when needsCommit is false', () => {
    const result = buildEvaluationResumePrompt({ critique: 'x', needsCommit: false });
    expect(result).not.toContain('commit the fix');
  });
});

// ---------------------------------------------------------------------------
// Cross-builder: distinct outputs for distinct inputs
// ---------------------------------------------------------------------------

describe('prompt builders produce distinct output for distinct inputs', () => {
  it('buildInteractivePrompt and buildAutoPrompt produce different text', () => {
    const ctx = 'context';
    const schema = '{}';
    const interactive = buildInteractivePrompt(ctx, '/output.json', schema, '');
    const auto = buildAutoPrompt(ctx, schema, '');
    expect(interactive).not.toBe(auto);
  });

  it('buildIdeatePrompt and buildIdeateAutoPrompt produce different text', () => {
    const schema = '{}';
    const interactive = buildIdeatePrompt('title', 'desc', 'proj', '/repo', '/out.json', schema, '');
    const headless = buildIdeateAutoPrompt('title', 'desc', 'proj', '/repo', schema, '');
    expect(interactive).not.toBe(headless);
  });
});

// ---------------------------------------------------------------------------
// Shared partial inlining — verifies harness-context, signals-*, validation
// are actually injected into the prompts that should reference them.
// ---------------------------------------------------------------------------

describe('shared partial inlining', () => {
  describe('harness-context partial', () => {
    it('is inlined into task-execution', () => {
      const result = buildTaskExecutionPrompt('/tmp/p.md', false, 'ctx.md');
      expect(result).toContain(PARTIAL_MARKERS.harnessContext);
    });

    it('is inlined into task-evaluation', () => {
      const result = buildEvaluatorPrompt({
        taskName: 't',
        taskDescription: '',
        taskSteps: [],
        verificationCriteria: [],
        projectPath: '/tmp',
        checkScriptSection: null,
        projectToolingSection: '',
        extraDimensions: [],
      });
      expect(result).toContain(PARTIAL_MARKERS.harnessContext);
    });

    it('is inlined into task-evaluation-resume', () => {
      const result = buildEvaluationResumePrompt({ critique: 'x', needsCommit: false });
      expect(result).toContain(PARTIAL_MARKERS.harnessContext);
    });

    it('is inlined into plan-auto', () => {
      const result = buildAutoPrompt('ctx', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.harnessContext);
    });

    it('is inlined into plan-interactive', () => {
      const result = buildInteractivePrompt('ctx', '/out.json', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.harnessContext);
    });

    it('is inlined into ideate', () => {
      const result = buildIdeatePrompt('t', 'd', 'p', '/r', '/out.json', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.harnessContext);
    });

    it('is inlined into ideate-auto', () => {
      const result = buildIdeateAutoPrompt('t', 'd', 'p', '/r', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.harnessContext);
    });

    it('is NOT inlined into ticket-refine (refinement is bounded by criteria, not tokens)', () => {
      const result = buildTicketRefinePrompt('## Ticket\n\nTitle: x', '/out.json', '{}');
      expect(result).not.toContain(PARTIAL_MARKERS.harnessContext);
    });
  });

  describe('signals partials (role-scoped)', () => {
    it('signals-task is inlined into task-execution', () => {
      const result = buildTaskExecutionPrompt('/tmp/p.md', false, 'ctx.md');
      expect(result).toContain(PARTIAL_MARKERS.signalsTask);
    });

    it('signals-task is inlined into task-evaluation-resume', () => {
      const result = buildEvaluationResumePrompt({ critique: 'x', needsCommit: false });
      expect(result).toContain(PARTIAL_MARKERS.signalsTask);
    });

    it('signals-planning is inlined into plan-auto', () => {
      const result = buildAutoPrompt('ctx', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.signalsPlanning);
    });

    it('signals-planning is inlined into plan-interactive', () => {
      const result = buildInteractivePrompt('ctx', '/out.json', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.signalsPlanning);
    });

    it('signals-planning is inlined into ideate', () => {
      const result = buildIdeatePrompt('t', 'd', 'p', '/r', '/out.json', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.signalsPlanning);
    });

    it('signals-planning is inlined into ideate-auto', () => {
      const result = buildIdeateAutoPrompt('t', 'd', 'p', '/r', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.signalsPlanning);
    });

    it('signals-evaluation is inlined into task-evaluation', () => {
      const result = buildEvaluatorPrompt({
        taskName: 't',
        taskDescription: '',
        taskSteps: [],
        verificationCriteria: [],
        projectPath: '/tmp',
        checkScriptSection: null,
        projectToolingSection: '',
        extraDimensions: [],
      });
      expect(result).toContain(PARTIAL_MARKERS.signalsEvaluation);
    });

    it('ticket-refine emits no signals (refinement does not produce signal output)', () => {
      const result = buildTicketRefinePrompt('## Ticket\n\nTitle: x', '/out.json', '{}');
      expect(result).not.toContain(PARTIAL_MARKERS.signalsTask);
      expect(result).not.toContain(PARTIAL_MARKERS.signalsPlanning);
      expect(result).not.toContain(PARTIAL_MARKERS.signalsEvaluation);
    });
  });

  describe('validation-checklist partial (planner-role only)', () => {
    it('is inlined into plan-auto', () => {
      const result = buildAutoPrompt('ctx', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.validation);
    });

    it('is inlined into plan-interactive', () => {
      const result = buildInteractivePrompt('ctx', '/out.json', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.validation);
    });

    it('is inlined into ideate', () => {
      const result = buildIdeatePrompt('t', 'd', 'p', '/r', '/out.json', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.validation);
    });

    it('is inlined into ideate-auto', () => {
      const result = buildIdeateAutoPrompt('t', 'd', 'p', '/r', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.validation);
    });

    it('is NOT inlined into task-execution (execution is not a planning role)', () => {
      const result = buildTaskExecutionPrompt('/tmp/p.md', false, 'ctx.md');
      expect(result).not.toContain(PARTIAL_MARKERS.validation);
    });

    it('is NOT inlined into ticket-refine', () => {
      const result = buildTicketRefinePrompt('## Ticket\n\nTitle: x', '/out.json', '{}');
      expect(result).not.toContain(PARTIAL_MARKERS.validation);
    });

    it('is NOT inlined into task-evaluation', () => {
      const result = buildEvaluatorPrompt({
        taskName: 't',
        taskDescription: '',
        taskSteps: [],
        verificationCriteria: [],
        projectPath: '/tmp',
        checkScriptSection: null,
        projectToolingSection: '',
        extraDimensions: [],
      });
      expect(result).not.toContain(PARTIAL_MARKERS.validation);
    });
  });

  describe('plan-common-examples partial (planner-role only)', () => {
    it('is inlined into plan-auto', () => {
      const result = buildAutoPrompt('ctx', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.planCommonExamples);
    });

    it('is inlined into plan-interactive', () => {
      const result = buildInteractivePrompt('ctx', '/out.json', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.planCommonExamples);
    });

    it('is inlined into ideate', () => {
      const result = buildIdeatePrompt('t', 'd', 'p', '/r', '/out.json', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.planCommonExamples);
    });

    it('is inlined into ideate-auto', () => {
      const result = buildIdeateAutoPrompt('t', 'd', 'p', '/r', '{}', '');
      expect(result).toContain(PARTIAL_MARKERS.planCommonExamples);
    });
  });
});

// ---------------------------------------------------------------------------
// TUI parity — prompts are surface-agnostic by construction
// ---------------------------------------------------------------------------
// loader.ts has no branching on whether the caller is the Ink TUI or the
// plain-text CLI. A given input produces byte-identical output regardless of
// surface. These assertions document that invariant and guard against a
// future "just inject some Ink / ANSI for the dashboard" temptation. See
// PROMPT-AUDIT.md § Verification Log for the full parity argument.
// ---------------------------------------------------------------------------

describe('prompt rendering is surface-agnostic (TUI parity)', () => {
  // eslint-disable-next-line no-control-regex -- detecting the CSI prefix IS the point here
  const ANSI_ESCAPE_RE = /\u001b\[/; // CSI sequence — ANSI colour / cursor control
  const INK_COMPONENT_RE = /<(Box|Text|Spinner|Banner|SectionStamp)\b/;

  it('buildAutoPrompt is deterministic across repeated calls with identical inputs', () => {
    const a = buildAutoPrompt('ctx', '{"test":true}', '');
    const b = buildAutoPrompt('ctx', '{"test":true}', '');
    expect(a).toBe(b);
  });

  it('rendered prompts contain no ANSI escape sequences', () => {
    const rendered: Record<string, string> = {
      planAuto: buildAutoPrompt('## Sprint\n\nT', '{}', ''),
      planInteractive: buildInteractivePrompt('## Sprint\n\nT', '/o', '{}', ''),
      ideate: buildIdeatePrompt('t', 'd', 'p', '/r', '/o', '{}', ''),
      ideateAuto: buildIdeateAutoPrompt('t', 'd', 'p', '/r', '{}', ''),
      taskExecution: buildTaskExecutionPrompt('/p.md', false, 'ctx.md'),
      taskEvaluation: buildEvaluatorPrompt({
        taskName: 't',
        taskDescription: '',
        taskSteps: [],
        verificationCriteria: [],
        projectPath: '/tmp',
        checkScriptSection: null,
        projectToolingSection: '',
        extraDimensions: [],
      }),
      ticketRefine: buildTicketRefinePrompt('## T\n\nx', '/o', '{}'),
      evaluationResume: buildEvaluationResumePrompt({ critique: 'x', needsCommit: false }),
    };
    for (const [name, out] of Object.entries(rendered)) {
      expect(out, `${name} must contain no ANSI escape sequences`).not.toMatch(ANSI_ESCAPE_RE);
      expect(out, `${name} must contain no Ink component tags`).not.toMatch(INK_COMPONENT_RE);
    }
  });
});

// ---------------------------------------------------------------------------
// Chain-of-Thought — <thinking> scratchpad scope
// ---------------------------------------------------------------------------

describe('headless planner <thinking> scratchpad', () => {
  it('plan-auto instructs the planner to reason in a <thinking> block', () => {
    const result = buildAutoPrompt('ctx', '{}', '');
    expect(result).toContain('<thinking>');
  });

  it('ideate-auto instructs the planner to reason in a <thinking> block', () => {
    const result = buildIdeateAutoPrompt('t', 'd', 'p', '/r', '{}', '');
    expect(result).toContain('<thinking>');
  });

  it('interactive plan does NOT include a <thinking> directive (reasoning happens live with the user)', () => {
    const result = buildInteractivePrompt('ctx', '/out.json', '{}', '');
    expect(result).not.toContain('<thinking>');
  });
});

// ---------------------------------------------------------------------------
// Generic prompt audits — leakage and ralphctl-specific content
// ---------------------------------------------------------------------------

describe('prompt template generic-content audits', () => {
  // Templates loaded from disk so the audit reflects actual file content,
  // not what a builder happens to substitute.
  const TEMPLATE_NAMES = [
    'plan-auto',
    'plan-interactive',
    'plan-common',
    'plan-common-examples',
    'ideate',
    'ideate-auto',
    'ticket-refine',
    'task-execution',
    'task-evaluation',
    'task-evaluation-resume',
    'harness-context',
    'signals-task',
    'signals-planning',
    'signals-evaluation',
    'validation-checklist',
    'sprint-feedback',
  ] as const;

  for (const name of TEMPLATE_NAMES) {
    describe(`${name}.md`, () => {
      const raw = loadPartial(name);

      it('does not reference ralphctl by name', () => {
        // Prompts run in DOWNSTREAM projects — they must stay generic.
        expect(raw.toLowerCase()).not.toContain('ralphctl');
      });

      it('does not hardcode harness-specific subagent names', () => {
        // Subagent names come from runtime detection of the target project's
        // .claude/agents/ directory, not from prompt content. Hardcoding any
        // name would mislead planners working against projects without it.
        // We check for backtick-quoted occurrences to avoid false positives
        // from generic English usage of "reviewer" / "tester" / etc. in prose.
        const hardcoded = ['`auditor`', '`reviewer`', '`tester`', '`designer`', '`implementer`', '`planner`'];
        for (const needle of hardcoded) {
          expect(raw).not.toContain(needle);
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Ecosystem-generic: no hardcoded package-manager commands in rendered
  // prompts. All tool-specific content must flow through {{PROJECT_TOOLING}}
  // or {{CHECK_GATE_EXAMPLE}} at runtime — the templates themselves must not
  // embed `pnpm`, `npm`, `pip`, `cargo`, or `go test`. Legitimate prose uses
  // of "npm" / "go" inside URLs or explanations are avoided by checking for
  // command-shaped tokens (trailing space or end-of-line).
  // -------------------------------------------------------------------------
  it('no planner / execution / evaluator rendered prompt embeds a package-manager command', () => {
    const rendered: Record<string, string> = {
      planAuto: buildAutoPrompt('## Sprint Context\n\nTicket: x', '{"type":"array"}', ''),
      planInteractive: buildInteractivePrompt('## Sprint Context\n\nTicket: x', '/out.json', '{"type":"array"}', ''),
      ideate: buildIdeatePrompt('t', 'd', 'p', '/r', '/out.json', '{"type":"object"}', ''),
      ideateAuto: buildIdeateAutoPrompt('t', 'd', 'p', '/r', '{"type":"object"}', ''),
      taskExecution: buildTaskExecutionPrompt('/tmp/progress.md', false, 'ctx.md'),
      taskEvaluation: buildEvaluatorPrompt({
        taskName: 't',
        taskDescription: '',
        taskSteps: [],
        verificationCriteria: [],
        projectPath: '/tmp',
        checkScriptSection: null,
        projectToolingSection: '',
        extraDimensions: [],
      }),
    };
    // Command-shaped tokens: the literal followed by a space (an argument)
    // or at end of a line. Avoids false positives from prose like "the
    // go.mod file" or "an npm package".
    const forbidden = [
      /\bpnpm\s/,
      /\bnpm\s+(run|test|install|ci|exec|publish)\b/,
      /\bnpx\s/,
      /\bpip\s+install\b/,
      /\bcargo\s+(build|test|run)\b/,
      /\bgo\s+test\b/,
    ];
    for (const [name, out] of Object.entries(rendered)) {
      for (const rx of forbidden) {
        expect(out, `${name} must not embed ${rx.source}`).not.toMatch(rx);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Structural: every planner-role rendered prompt uses at least one of the
  // canonical XML tags to wrap its top-level inputs. The vocabulary is fixed
  // in PROMPT-AUDIT.md and CLAUDE.md; a new tag requires updating both docs
  // AND expanding this allowlist.
  // -------------------------------------------------------------------------
  it('planner-role rendered prompts wrap top-level inputs inside a known XML tag', () => {
    const plannerRendered: Record<string, string> = {
      planAuto: buildAutoPrompt('## Sprint Context\n\nTicket: x', '{"type":"array"}', ''),
      planInteractive: buildInteractivePrompt('## Sprint Context\n\nTicket: x', '/out.json', '{"type":"array"}', ''),
      ideate: buildIdeatePrompt('t', 'd', 'p', '/r', '/out.json', '{"type":"object"}', ''),
      ideateAuto: buildIdeateAutoPrompt('t', 'd', 'p', '/r', '{"type":"object"}', ''),
      taskEvaluation: buildEvaluatorPrompt({
        taskName: 't',
        taskDescription: '',
        taskSteps: [],
        verificationCriteria: [],
        projectPath: '/tmp',
        checkScriptSection: null,
        projectToolingSection: '',
        extraDimensions: [],
      }),
    };
    const knownTagRe =
      /<(task-specification|context|requirements|constraints|examples|dimension|signals|validation-checklist|harness-context)\b/;
    for (const [name, out] of Object.entries(plannerRendered)) {
      expect(out, `${name} must wrap inputs in a known XML tag`).toMatch(knownTagRe);
    }
  });

  // -------------------------------------------------------------------------
  // Placeholder hygiene: conditional placeholders must expand cleanly when
  // empty. Concretely:
  //   - buildTaskExecutionPrompt(noCommit=true) → no orphan numbering (no
  //     `1.\n\n3.` skip), no triple-newline runs, no trailing-space bullets.
  //   - buildEvaluatorPrompt(extraDimensions=[]) → same guarantees around
  //     the EXTRA_DIMENSIONS_* slots.
  // -------------------------------------------------------------------------
  it('conditional placeholders expand cleanly when empty', () => {
    const taskExecEmpty = buildTaskExecutionPrompt('/tmp/progress.md', true, 'ctx.md');
    // No orphan numbering in the Phase 3 list: step 2 must be directly
    // followed by step 3, possibly with blank lines. Skipped numbers (e.g.
    // "1." then "3." with no "2.") would indicate a swallowed conditional.
    const phase3 = taskExecEmpty.split('## Phase 3: Completion')[1] ?? '';
    expect(phase3, 'Phase 3 step 1 must be present').toMatch(/^\s*1\. /m);
    expect(phase3, 'Phase 3 step 2 must be present').toMatch(/^\s*2\. /m);
    expect(phase3, 'Phase 3 step 3 must be present').toMatch(/^\s*3\. /m);
    // No unreplaced placeholders leaked through.
    expect(taskExecEmpty).not.toMatch(/\{\{[A-Z_]+\}\}/);
    // When noCommit is true the commit reminder is gone but Phase 3 stays
    // intact.
    expect(taskExecEmpty).not.toContain('Before continuing');
    // And the swallowed conditional must not leave an indented-only line —
    // that was the Phase 3 cosmetic nit called out in the prompt-audit review.
    expect(taskExecEmpty, 'no line may contain only leading whitespace').not.toMatch(/^[ \t]+$/m);

    const evalEmpty = buildEvaluatorPrompt({
      taskName: 't',
      taskDescription: '',
      taskSteps: [],
      verificationCriteria: [],
      projectPath: '/tmp',
      checkScriptSection: null,
      projectToolingSection: '',
      extraDimensions: [],
    });
    expect(evalEmpty).not.toMatch(/\{\{[A-Z_]+\}\}/);
    // The Assessment output block still emits the four floor lines — an
    // empty EXTRA_DIMENSIONS_ASSESSMENT_* slot must not swallow them.
    expect(evalEmpty).toContain('**Correctness**: PASS — [one-line finding]');
    expect(evalEmpty).toContain('**Consistency**: PASS/FAIL — [one-line finding]');
    // No extra-dimension blocks leaked when extras is empty.
    expect(evalEmpty).not.toContain('floor="false"');
  });
});
