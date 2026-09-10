import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { computePlaceholderParity, loadPartialMap } from '@src/integration/ai/prompts/_engine/test-utils.ts';
import { buildIdeatePrompt, ideatePromptDef } from '@src/integration/ai/prompts/ideate/definition.ts';
import { parseIdeateOutput } from '@src/integration/ai/prompts/ideate/parse-output.ts';
import { composePriorLearnings } from '@src/application/flows/_shared/memory/compose-prior-learnings.ts';
import { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { makeProject, makeRepository } from '@tests/fixtures/domain.ts';

const loader = createFsTemplateLoader(defaultTemplatesDir());

const readTemplate = async (): Promise<string> =>
  fs.readFile(`${String(defaultTemplatesDir())}/ideate/template.md`, 'utf8');

describe('ideatePromptDef — completeness', () => {
  it('expectedSignals advertises ideated-tickets plus the narrative fan-out trio', () => {
    // Locked down so future template edits that drop / add a signal kind force a conscious
    // expectedSignals review. The ideate contract schema accepts the same four kinds.
    expect(ideatePromptDef.expectedSignals).toEqual(['ideated-tickets', 'note', 'learning', 'decision']);
  });

  it('placeholder ↔ parameter parity', async () => {
    const rawTemplate = await readTemplate();
    const partials = await loadPartialMap(ideatePromptDef, loader);
    const report = computePlaceholderParity({ def: ideatePromptDef, rawTemplate, partials });
    expect(report.unsatisfied).toEqual([]);
    expect(report.unreferenced).toEqual([]);
  });
});

const SAMPLE_CONTRACT_SECTION = '## Output contract\n\nWrite signals.json. (test fixture body.)';

describe('buildIdeatePrompt — end-to-end', () => {
  it('renders a fully-substituted prompt', async () => {
    const project = makeProject({ displayName: 'Demo' });
    const result = await buildIdeatePrompt(loader, {
      ideaTitle: 'CSV export',
      ideaDescription: 'Add CSV export to reports.',
      project,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(result.value).toContain('CSV export');
    expect(result.value).toContain('## Output contract');
    expect(result.value).toContain('<prior_progress>');
  });

  it('renders the shared task-fields and task-sizing partials, not an inlined copy', async () => {
    // Regression: ideate used to hand-write the same per-field task schema and sizing rules that
    // plan also hand-wrote. Both templates now render the same _partials/task-fields.md /
    // task-sizing.md bodies, so a schema change is one edit instead of two silently-drifting ones.
    const project = makeProject({ displayName: 'Demo' });
    const result = await buildIdeatePrompt(loader, {
      ideaTitle: 'CSV export',
      ideaDescription: 'Add CSV export to reports.',
      project,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const normalized = (result.value as unknown as string).replace(/\s+/g, ' ');
    expect(normalized).toContain('Do NOT end steps with "run the verification commands"');
    expect(normalized).toContain('Fold trivial cases into the task that needs them');
    // Regression: the shared partial dropped the worked example for `extraDimensions` — the one
    // field whose rule is "attach ONLY when …, when in doubt omit" lost its only demonstration
    // of the allowed case.
    expect(normalized).toContain('Example of a justified attachment: `migration-safety`');
  });

  it('does not hand-write a second, rival JSON example for the ideated-tickets shape', async () => {
    // Regression: the template used to hand-author a full `signals.json` example (its own
    // `schemaVersion`/`signals`/`outputJson` JSON fence) immediately before the machine-rendered
    // {{OUTPUT_CONTRACT_SECTION}}, which renders the same shape from the real contract. Two
    // independently-maintained examples for the same file can drift; only the rendered one (from
    // outputContractSection, a plain test fixture here) may describe the JSON shape.
    const project = makeProject({ displayName: 'Demo' });
    const result = await buildIdeatePrompt(loader, {
      ideaTitle: 'CSV export',
      ideaDescription: 'Add CSV export to reports.',
      project,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The stub outputContractSection fixture never mentions "ideated-tickets" or "outputJson" —
    // if either appears in the rendered body, it came from a hand-written block in the template
    // itself, not the injected contract section.
    expect(result.value).not.toContain('"type": "ideated-tickets"');
    expect(result.value).not.toContain('"outputJson"');
  });

  it('rejects empty ideaTitle', async () => {
    const project = makeProject();
    const result = await buildIdeatePrompt(loader, {
      ideaTitle: '   ',
      ideaDescription: 'desc',
      project,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('injects the prior-learnings section when the ledger has records', async () => {
    const project = makeProject({ displayName: 'Demo' });
    // Compose the section body the way the flow does — from real ledger records.
    const priorLearnings = composePriorLearnings([
      {
        v: 1,
        id: 'l1',
        kind: 'learning',
        text: 'auth module has hidden coupling to the shared session cache — touch both together',
        repo: '/repos/app',
        repoName: 'app',
        taskKind: 'feature',
        sprintId: 's-prev',
        taskId: 't-prev',
        timestamp: '2026-05-30T10:00:00.000Z',
        promotedAt: null,
      },
    ]);
    const result = await buildIdeatePrompt(loader, {
      ideaTitle: 'CSV export',
      ideaDescription: 'Add CSV export to reports.',
      project,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
      priorLearnings,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('## Learnings from prior sprints');
    expect(result.value).toContain('auth module has hidden coupling to the shared session cache');
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('omits the prior-learnings section cleanly when the ledger is empty', async () => {
    const project = makeProject({ displayName: 'Demo' });
    const result = await buildIdeatePrompt(loader, {
      ideaTitle: 'CSV export',
      ideaDescription: 'Add CSV export to reports.',
      project,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
      // No priorLearnings → the rendered `## Learnings` heading is absent; wrapper + note stay.
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('## Learnings from prior sprints');
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe('ideate/template.md — documented output example', () => {
  // Regression: the template used to point at a bare-string `verificationCriteria` shape that
  // `VerificationCriterionImportSchema` rejects (structured objects only), so a model that
  // copied the "authoritative" example produced a signals.json the harness could never parse —
  // after both human approval gates had already passed. This test extracts the decoded
  // `outputJson` example straight from the template and runs it through the real production
  // parser, so a future edit that reintroduces an unparseable example fails here instead of in
  // a live ideate session.
  it('the decoded outputJson example parses through the real ideate output parser', async () => {
    const raw = await readTemplate();
    const fence = raw.match(/Decoded, `outputJson` looks like this[\s\S]*?```json\n([\s\S]*?)\n```/);
    expect(fence).not.toBeNull();
    const exampleSource = fence?.[1] ?? '';

    // The example must itself be valid JSON before it can be handed to the parser.
    const decoded: unknown = JSON.parse(exampleSource);

    const ticketId = TicketId.parse('01900000-0000-7000-8000-00000000aaaa');
    if (!ticketId.ok) throw new Error('test setup: bad ticketId fixture');
    const sprintId = SprintId.parse('01900000-0000-7000-8000-00000000bbbb');
    if (!sprintId.ok) throw new Error('test setup: bad sprintId fixture');
    const project = makeProject({ repositories: [makeRepository({ path: '/abs/repo' })] });

    const result = parseIdeateOutput(JSON.stringify(decoded), {
      project,
      sprintId: sprintId.value,
      ticketId: ticketId.value,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tasks).toHaveLength(1);
    expect(result.value.tasks[0]?.verificationCriteria).toEqual([
      {
        id: 'C1',
        assertion: 'TypeScript compiles with no errors',
        check: 'auto',
        command: '<project typecheck command>',
      },
      { id: 'C2', assertion: 'API returns 400 on invalid input', check: 'manual' },
    ]);
  });
});
