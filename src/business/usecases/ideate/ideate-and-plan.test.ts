import { describe, expect, it } from 'vitest';

import { Project } from '../../../domain/entities/project.ts';
import { Repository } from '../../../domain/entities/repository.ts';
import { Sprint } from '../../../domain/entities/sprint.ts';
import { StorageError } from '../../../domain/errors/storage-error.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { FakeAiSessionPort } from '../../_test-fakes/fake-ai-session-port.ts';
import { FakeLoggerPort } from '../../_test-fakes/fake-logger-port.ts';
import { FakePromptBuilderPort } from '../../_test-fakes/fake-prompt-builder-port.ts';
import { IdeateAndPlanUseCase } from './ideate-and-plan.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;
const PROJECT_PATH = '/repos/demo';

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectName(): ProjectName {
  const r = ProjectName.parse('demo');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectPath(): AbsolutePath {
  const r = AbsolutePath.parse(PROJECT_PATH);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function cwd(): AbsolutePath {
  const r = AbsolutePath.parse('/tmp/ralphctl-ideate');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function newProject(): Project {
  const repo = Repository.create({ path: projectPath() });
  if (!repo.ok) throw new Error('precondition failed');
  const p = Project.create({
    name: projectName(),
    displayName: 'Demo',
    repositories: [repo.value],
  });
  if (!p.ok) throw new Error('precondition failed');
  return p.value;
}

function newDraftSprint(): Sprint {
  const sprint = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
  if (!sprint.ok) throw new Error('precondition failed');
  return sprint.value;
}

const TASK_ENTRY = {
  name: 'first',
  steps: [],
  verificationCriteria: [],
  order: 1,
  projectPath: PROJECT_PATH,
};

function buildOutput(opts: {
  ticketTitle?: string;
  ticketDescription?: string;
  requirements?: string;
  tasks?: readonly object[];
}): string {
  const tasksJson = JSON.stringify(opts.tasks ?? [TASK_ENTRY]);
  if (opts.ticketTitle === undefined) {
    // Bare-tasks-array case: omit the <ticket> block entirely.
    return tasksJson;
  }
  return [
    '<ticket>',
    `  <title>${opts.ticketTitle}</title>`,
    opts.ticketDescription !== undefined ? `  <description>${opts.ticketDescription}</description>` : '',
    opts.requirements !== undefined ? `  <requirements>${opts.requirements}</requirements>` : '',
    '</ticket>',
    '<tasks>',
    tasksJson,
    '</tasks>',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

describe('IdeateAndPlanUseCase', () => {
  it('parses ticket + tasks blocks and returns an approved ticket', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [
        {
          kind: 'ok',
          result: {
            output: buildOutput({
              ticketTitle: 'My Idea',
              ticketDescription: 'short blurb',
              requirements: 'must do X',
            }),
          },
        },
      ],
    });
    const uc = new IdeateAndPlanUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: newDraftSprint(),
      ideaText: 'idea text',
      project: newProject(),
      cwd: cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.title).toBe('My Idea');
    expect(result.value.ticket.description).toBe('short blurb');
    expect(result.value.ticket.requirementStatus).toBe('approved');
    expect(result.value.ticket.requirements).toBe('must do X');
    expect(result.value.ticket.projectName).toBe(projectName());
    expect(result.value.tasks).toHaveLength(1);
    expect(result.value.tasks[0]?.ticketId).toBe(result.value.ticket.id);
  });

  it('accepts a bare tasks array — empty requirements, idea text becomes title', async () => {
    const longIdea = 'a'.repeat(120);
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: buildOutput({}) } }],
    });
    const uc = new IdeateAndPlanUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: newDraftSprint(),
      ideaText: longIdea,
      project: newProject(),
      cwd: cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.requirements).toBe('');
    expect(result.value.ticket.title.length).toBeLessThanOrEqual(80);
    expect(result.value.ticket.title).toBe(longIdea.slice(0, 80));
  });

  it('rejects ideation on a non-draft sprint', async () => {
    const draft = newDraftSprint();
    const active = draft.activate(T0);
    if (!active.ok) throw new Error('precondition failed');

    const ai = new FakeAiSessionPort();
    const uc = new IdeateAndPlanUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: active.value,
      ideaText: 'x',
      project: newProject(),
      cwd: cwd(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-state');
      if (result.error.code === 'invalid-state') {
        expect(result.error.attemptedAction).toBe('ideate');
      }
    }
    expect(ai.captured).toHaveLength(0);
  });

  it('passes the idea text through to the prompt builder', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [
        {
          kind: 'ok',
          result: { output: buildOutput({ ticketTitle: 't', requirements: 'r' }) },
        },
      ],
    });
    const prompts = new FakePromptBuilderPort();
    const uc = new IdeateAndPlanUseCase(ai, prompts, new FakeLoggerPort());

    await uc.execute({
      sprint: newDraftSprint(),
      ideaText: 'fixed-idea',
      project: newProject(),
      cwd: cwd(),
    });

    expect(prompts.ideateCalls).toHaveLength(1);
    expect(prompts.ideateCalls[0]?.ideaText).toBe('fixed-idea');
  });

  it('returns ParseError when neither <tasks> nor a bare array is present', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '<ticket><title>x</title></ticket>' } }],
    });
    const uc = new IdeateAndPlanUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: newDraftSprint(),
      ideaText: 'x',
      project: newProject(),
      cwd: cwd(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
    }
  });

  it('returns ParseError when tasks block contains malformed JSON', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '<tasks>not json</tasks>' } }],
    });
    const uc = new IdeateAndPlanUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: newDraftSprint(),
      ideaText: 'x',
      project: newProject(),
      cwd: cwd(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
    }
  });

  it('propagates an AI session failure', async () => {
    const failure = new StorageError({ subCode: 'io', message: 'spawn failed' });
    const ai = new FakeAiSessionPort({ outcomes: [{ kind: 'error', error: failure }] });
    const uc = new IdeateAndPlanUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: newDraftSprint(),
      ideaText: 'x',
      project: newProject(),
      cwd: cwd(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('storage-error');
    }
  });

  it('forwards the abort signal to the AI session', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [
        {
          kind: 'ok',
          result: { output: buildOutput({ ticketTitle: 't', requirements: 'r' }) },
        },
      ],
    });
    const uc = new IdeateAndPlanUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());
    const ac = new AbortController();

    await uc.execute({
      sprint: newDraftSprint(),
      ideaText: 'x',
      project: newProject(),
      cwd: cwd(),
      abortSignal: ac.signal,
    });

    expect(ai.captured[0]?.options.abortSignal).toBe(ac.signal);
  });
});
