import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { computePlaceholderParity, loadPartialMap } from '@src/integration/ai/prompts/_engine/test-utils.ts';
import { promises as fs } from 'node:fs';
import {
  applyFeedbackPromptDef,
  buildApplyFeedbackPrompt,
} from '@src/integration/ai/prompts/apply-feedback/definition.ts';

const loader = createFsTemplateLoader(defaultTemplatesDir());

const readTemplate = async (): Promise<string> =>
  fs.readFile(`${String(defaultTemplatesDir())}/apply-feedback/template.md`, 'utf8');

describe('applyFeedbackPromptDef — completeness', () => {
  it('placeholder ↔ parameter parity', async () => {
    const rawTemplate = await readTemplate();
    const partials = await loadPartialMap(applyFeedbackPromptDef, loader);
    const report = computePlaceholderParity({ def: applyFeedbackPromptDef, rawTemplate, partials });
    expect(
      report.unsatisfied,
      `template references placeholders the def doesn't declare: ${report.unsatisfied.join(', ')}`
    ).toEqual([]);
    expect(
      report.unreferenced,
      `def declares placeholders the template never references: ${report.unreferenced.join(', ')}`
    ).toEqual([]);
  });
});

describe('apply-feedback template wording', () => {
  it('states the latest-round rule once and carries no stale phrasing', async () => {
    const raw = await readTemplate();
    expect(raw.match(/Latest round wins/g)).toHaveLength(1);
    for (const stale of ['invariant established by a prior round', 'dirty-tree', 'Critical divergence', 'NOW']) {
      expect(raw).not.toContain(stale);
    }
  });

  it('declares the autonomous-operation and git-boundary partials', () => {
    expect(applyFeedbackPromptDef.partials).toMatchObject({
      AUTONOMOUS_OPERATION: 'autonomous-operation',
      GIT_BOUNDARY: 'git-boundary',
    });
  });
});

describe('buildApplyFeedbackPrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt and lists every repository', async () => {
    const repositoriesBlock = ['- `/tmp/proj-a` (proj-a)', '- `/tmp/proj-b` (proj-b)'].join('\n');
    const result = await buildApplyFeedbackPrompt(loader, {
      repositories: repositoriesBlock,
      sprintContext: 'sprint ABC',
      feedbackLog: '',
      latestRound: 'Please simplify the X feature.',
      progress: 'Progress so far: …',
      outputContractSection: '## Output contract\n\nWrite signals.json to /tmp/out.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
    // Every repo path the launcher mounted must surface in the prompt — this is what tells
    // the AI it can write into a non-first repo on multi-repo sprints.
    expect(result.value).toContain('/tmp/proj-a');
    expect(result.value).toContain('/tmp/proj-b');
    expect(result.value).toContain('Please simplify the X feature.');
  });

  it("lets the operator's request override the git boundary's no-delete/no-revert rule", async () => {
    const result = await buildApplyFeedbackPrompt(loader, {
      repositories: '- `/tmp/proj-a` (proj-a)',
      sprintContext: 'sprint ABC',
      feedbackLog: '',
      latestRound: 'Remove the legacy helper file.',
      progress: '',
      outputContractSection: '## Output contract\n\nWrite signals.json to /tmp/out.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundary = /<git_boundary>([\s\S]*?)<\/git_boundary>/.exec(result.value)?.[1]?.replace(/\s+/g, ' ') ?? '';
    expect(boundary).toMatch(
      /do not delete, revert, or `git clean` files you did not create — except when[^.]*operator's request/
    );
  });

  it('rejects an empty latestRound via the spec validator', async () => {
    const result = await buildApplyFeedbackPrompt(loader, {
      repositories: '- `/tmp/proj` (proj)',
      sprintContext: 'sprint ABC',
      feedbackLog: '',
      latestRound: '   ',
      progress: '',
      outputContractSection: '## Output contract\n\nWrite signals.json to /tmp/out.',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty repositories block via the spec validator', async () => {
    const result = await buildApplyFeedbackPrompt(loader, {
      repositories: '   ',
      sprintContext: 'sprint ABC',
      feedbackLog: '',
      latestRound: 'do the thing',
      progress: '',
      outputContractSection: '## Output contract\n\nWrite signals.json to /tmp/out.',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
