import { describe, expect, it } from 'vitest';
import {
  buildAutoPrompt,
  buildIdeateAutoPrompt,
  buildIdeatePrompt,
  buildInteractivePrompt,
  buildTaskExecutionPrompt,
  buildTicketRefinePrompt,
} from './index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns all unreplaced {{PLACEHOLDER}} tokens found in text. */
function findUnreplacedTokens(text: string): string[] {
  return [...text.matchAll(/\{\{[A-Z_]+\}\}/g)].map((m) => m[0]);
}

// ---------------------------------------------------------------------------
// buildInteractivePrompt
// ---------------------------------------------------------------------------

describe('buildInteractivePrompt', () => {
  const context = '## Sprint Context\n\nTicket: Add login';
  const outputFile = '/tmp/sprint/planning/tasks.json';
  const schema = '{"type":"array","items":{}}';

  it('produces non-empty output', () => {
    const result = buildInteractivePrompt(context, outputFile, schema);
    expect(result.length).toBeGreaterThan(0);
  });

  it('leaves no unreplaced {{...}} tokens', () => {
    const result = buildInteractivePrompt(context, outputFile, schema);
    expect(findUnreplacedTokens(result)).toEqual([]);
  });

  it('includes the context in the output', () => {
    const result = buildInteractivePrompt(context, outputFile, schema);
    expect(result).toContain('Ticket: Add login');
  });

  it('includes the output file path', () => {
    const result = buildInteractivePrompt(context, outputFile, schema);
    expect(result).toContain(outputFile);
  });

  it('includes the JSON schema', () => {
    const result = buildInteractivePrompt(context, outputFile, schema);
    expect(result).toContain(schema);
  });

  it('inlines the plan-common template content', () => {
    const result = buildInteractivePrompt(context, outputFile, schema);
    // plan-common contains sections about "What Makes a Great Task" or "Dependency Graph"
    expect(result).toMatch(/What Makes a Great Task|Dependency Graph/i);
  });
});

// ---------------------------------------------------------------------------
// buildAutoPrompt
// ---------------------------------------------------------------------------

describe('buildAutoPrompt', () => {
  const context = '## Sprint Context\n\nTicket: Migrate database';
  const schema = '{"type":"array"}';

  it('produces non-empty output', () => {
    const result = buildAutoPrompt(context, schema);
    expect(result.length).toBeGreaterThan(0);
  });

  it('leaves no unreplaced {{...}} tokens', () => {
    const result = buildAutoPrompt(context, schema);
    expect(findUnreplacedTokens(result)).toEqual([]);
  });

  it('includes the context in the output', () => {
    const result = buildAutoPrompt(context, schema);
    expect(result).toContain('Ticket: Migrate database');
  });

  it('includes the JSON schema', () => {
    const result = buildAutoPrompt(context, schema);
    expect(result).toContain(schema);
  });

  it('inlines plan-common content', () => {
    const result = buildAutoPrompt(context, schema);
    expect(result).toMatch(/What Makes a Great Task|Dependency Graph/i);
  });

  it('does not include OUTPUT_FILE (auto mode writes directly)', () => {
    // Auto mode outputs JSON directly — there is no output file placeholder
    const result = buildAutoPrompt(context, schema);
    expect(result).not.toContain('{{OUTPUT_FILE}}');
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
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema);
    expect(result.length).toBeGreaterThan(0);
  });

  it('leaves no unreplaced {{...}} tokens', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema);
    expect(findUnreplacedTokens(result)).toEqual([]);
  });

  it('includes the idea title', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema);
    expect(result).toContain(ideaTitle);
  });

  it('includes the idea description', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema);
    expect(result).toContain(ideaDescription);
  });

  it('includes the project name', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema);
    expect(result).toContain(projectName);
  });

  it('includes the repositories', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema);
    expect(result).toContain(repositories);
  });

  it('includes the output file path', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema);
    expect(result).toContain(outputFile);
  });

  it('includes the JSON schema', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema);
    expect(result).toContain(schema);
  });

  it('inlines plan-common content', () => {
    const result = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositories, outputFile, schema);
    expect(result).toMatch(/What Makes a Great Task|Dependency Graph/i);
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
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema);
    expect(result.length).toBeGreaterThan(0);
  });

  it('leaves no unreplaced {{...}} tokens', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema);
    expect(findUnreplacedTokens(result)).toEqual([]);
  });

  it('includes the idea title', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema);
    expect(result).toContain(ideaTitle);
  });

  it('includes the idea description', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema);
    expect(result).toContain(ideaDescription);
  });

  it('includes the project name', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema);
    expect(result).toContain(projectName);
  });

  it('includes the repositories', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema);
    expect(result).toContain(repositories);
  });

  it('includes the JSON schema', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema);
    expect(result).toContain(schema);
  });

  it('inlines plan-common content', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema);
    expect(result).toMatch(/What Makes a Great Task|Dependency Graph/i);
  });

  it('does not include OUTPUT_FILE (auto mode outputs directly)', () => {
    const result = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositories, schema);
    expect(result).not.toContain('{{OUTPUT_FILE}}');
  });
});

// ---------------------------------------------------------------------------
// Cross-builder: distinct outputs for distinct inputs
// ---------------------------------------------------------------------------

describe('prompt builders produce distinct output for distinct inputs', () => {
  it('buildInteractivePrompt and buildAutoPrompt produce different text', () => {
    const ctx = 'context';
    const schema = '{}';
    const interactive = buildInteractivePrompt(ctx, '/output.json', schema);
    const auto = buildAutoPrompt(ctx, schema);
    expect(interactive).not.toBe(auto);
  });

  it('buildIdeatePrompt and buildIdeateAutoPrompt produce different text', () => {
    const schema = '{}';
    const interactive = buildIdeatePrompt('title', 'desc', 'proj', '/repo', '/out.json', schema);
    const headless = buildIdeateAutoPrompt('title', 'desc', 'proj', '/repo', schema);
    expect(interactive).not.toBe(headless);
  });
});
