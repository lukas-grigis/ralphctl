import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
} from './index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns all unreplaced {{PLACEHOLDER}} tokens found in text. */
function findUnreplacedTokens(text: string): string[] {
  return [...text.matchAll(/\{\{[A-Z_]+\}\}/g)].map((m) => m[0]);
}

/** Marker phrases unique to each shared partial — used to assert inlining. */
const PARTIAL_MARKERS = {
  harnessContext: /automatically compacted/,
  validation: /Pre-Output Validation/,
  signalsTask: '<task-verified>',
  signalsPlanning: '<planning-blocked>',
  signalsEvaluation: '<evaluation-passed>',
} as const;

/** Loads a raw template from disk for placeholder-coverage tests. */
function loadRawTemplate(name: string): string {
  return readFileSync(join(__dirname, `${name}.md`), 'utf-8');
}

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

  it('leaves no unreplaced {{...}} tokens', () => {
    const result = buildInteractivePrompt(context, outputFile, schema, '');
    expect(findUnreplacedTokens(result)).toEqual([]);
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

  it('leaves no unreplaced {{...}} tokens', () => {
    const result = buildAutoPrompt(context, schema, '');
    expect(findUnreplacedTokens(result)).toEqual([]);
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

  it('leaves no unreplaced {{...}} tokens when all args provided', () => {
    const result = buildTicketRefinePrompt(ticket, outputFile, schema, 'Issue context here');
    expect(findUnreplacedTokens(result)).toEqual([]);
  });

  it('leaves no unreplaced tokens when issueContext is omitted (defaults to empty string)', () => {
    const result = buildTicketRefinePrompt(ticket, outputFile, schema);
    expect(findUnreplacedTokens(result)).toEqual([]);
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

  it('leaves no unreplaced {{...}} tokens', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema, '');
    expect(findUnreplacedTokens(result)).toEqual([]);
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

  it('leaves no unreplaced {{...}} tokens', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema, '');
    expect(findUnreplacedTokens(result)).toEqual([]);
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
  };

  it('leaves no unreplaced {{...}} tokens with empty optional sections', () => {
    const result = buildEvaluatorPrompt(baseCtx);
    expect(findUnreplacedTokens(result)).toEqual([]);
  });

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
});

// ---------------------------------------------------------------------------
// buildEvaluationResumePrompt
// ---------------------------------------------------------------------------

describe('buildEvaluationResumePrompt', () => {
  it('embeds the critique into the template', () => {
    const result = buildEvaluationResumePrompt({ critique: 'Bug at src/foo.ts:42', needsCommit: false });
    expect(result).toContain('Bug at src/foo.ts:42');
    expect(findUnreplacedTokens(result)).toEqual([]);
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
      expect(result).toMatch(PARTIAL_MARKERS.harnessContext);
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
      });
      expect(result).toMatch(PARTIAL_MARKERS.harnessContext);
    });

    it('is inlined into task-evaluation-resume', () => {
      const result = buildEvaluationResumePrompt({ critique: 'x', needsCommit: false });
      expect(result).toMatch(PARTIAL_MARKERS.harnessContext);
    });

    it('is inlined into plan-auto', () => {
      const result = buildAutoPrompt('ctx', '{}', '');
      expect(result).toMatch(PARTIAL_MARKERS.harnessContext);
    });

    it('is inlined into plan-interactive', () => {
      const result = buildInteractivePrompt('ctx', '/out.json', '{}', '');
      expect(result).toMatch(PARTIAL_MARKERS.harnessContext);
    });

    it('is inlined into ideate', () => {
      const result = buildIdeatePrompt('t', 'd', 'p', '/r', '/out.json', '{}', '');
      expect(result).toMatch(PARTIAL_MARKERS.harnessContext);
    });

    it('is inlined into ideate-auto', () => {
      const result = buildIdeateAutoPrompt('t', 'd', 'p', '/r', '{}', '');
      expect(result).toMatch(PARTIAL_MARKERS.harnessContext);
    });

    it('is NOT inlined into ticket-refine (refinement is bounded by criteria, not tokens)', () => {
      const result = buildTicketRefinePrompt('## Ticket\n\nTitle: x', '/out.json', '{}');
      expect(result).not.toMatch(PARTIAL_MARKERS.harnessContext);
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
      expect(result).toMatch(PARTIAL_MARKERS.validation);
    });

    it('is inlined into plan-interactive', () => {
      const result = buildInteractivePrompt('ctx', '/out.json', '{}', '');
      expect(result).toMatch(PARTIAL_MARKERS.validation);
    });

    it('is inlined into ideate', () => {
      const result = buildIdeatePrompt('t', 'd', 'p', '/r', '/out.json', '{}', '');
      expect(result).toMatch(PARTIAL_MARKERS.validation);
    });

    it('is inlined into ideate-auto', () => {
      const result = buildIdeateAutoPrompt('t', 'd', 'p', '/r', '{}', '');
      expect(result).toMatch(PARTIAL_MARKERS.validation);
    });

    it('is NOT inlined into task-execution (execution is not a planning role)', () => {
      const result = buildTaskExecutionPrompt('/tmp/p.md', false, 'ctx.md');
      expect(result).not.toMatch(PARTIAL_MARKERS.validation);
    });

    it('is NOT inlined into ticket-refine', () => {
      const result = buildTicketRefinePrompt('## Ticket\n\nTitle: x', '/out.json', '{}');
      expect(result).not.toMatch(PARTIAL_MARKERS.validation);
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
      });
      expect(result).not.toMatch(PARTIAL_MARKERS.validation);
    });
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
  ] as const;

  for (const name of TEMPLATE_NAMES) {
    describe(`${name}.md`, () => {
      const raw = loadRawTemplate(name);

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
});
