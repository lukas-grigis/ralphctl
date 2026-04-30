import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import { StorageError } from '../../../domain/errors/storage-error.ts';
import { Result } from '../../../domain/result.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { FakeExternalPort } from '../../_test-fakes/fake-external-port.ts';
import { FakeLoggerPort } from '../../_test-fakes/fake-logger-port.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { CreatePullRequestUseCase } from './create-pull-request.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;
const cwd = AbsolutePath.trustString('/repo');

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw r.error;
  return r.value;
}

function draftSprint(): Sprint {
  const r = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
  if (!r.ok) throw r.error;
  return r.value;
}

function sprintWithBranch(branch = 'ralphctl/test'): Sprint {
  const s = draftSprint().setBranch(branch);
  if (!s.ok) throw s.error;
  return s.value;
}

describe('CreatePullRequestUseCase', () => {
  it('creates a PR via ExternalPort and persists the URL on the sprint', async () => {
    const sprint = sprintWithBranch('ralphctl/x');
    const repo = new InMemorySprintRepository([sprint]);
    const external = new FakeExternalPort({
      createPullRequestOutcomes: [Result.ok({ url: 'https://github.com/o/r/pull/1' })],
    });
    const uc = new CreatePullRequestUseCase(external, repo, new FakeLoggerPort());

    const result = await uc.execute({
      sprint,
      cwd,
      base: 'main',
      title: 'feat: x',
      body: 'body',
      draft: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe('https://github.com/o/r/pull/1');
    expect(result.value.sprint.pullRequestUrl).toBe('https://github.com/o/r/pull/1');
    expect(external.createPullRequestCalls).toHaveLength(1);
    expect(external.createPullRequestCalls[0]?.branch).toBe('ralphctl/x');
    expect(external.createPullRequestCalls[0]?.base).toBe('main');
    expect(external.createPullRequestCalls[0]?.draft).toBe(false);

    const reread = await repo.findById(sprint.id);
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(reread.value.pullRequestUrl).toBe('https://github.com/o/r/pull/1');
  });

  it('fails with InvalidStateError when the sprint has no branch', async () => {
    const sprint = draftSprint();
    const repo = new InMemorySprintRepository([sprint]);
    const external = new FakeExternalPort();
    const uc = new CreatePullRequestUseCase(external, repo, new FakeLoggerPort());

    const result = await uc.execute({
      sprint,
      cwd,
      base: 'main',
      title: 'x',
      body: 'b',
      draft: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(external.createPullRequestCalls).toHaveLength(0);
  });

  it('propagates ExternalPort failures unchanged', async () => {
    const sprint = sprintWithBranch();
    const repo = new InMemorySprintRepository([sprint]);
    const external = new FakeExternalPort({
      createPullRequestOutcomes: [Result.error(new StorageError({ subCode: 'io', message: 'gh: not authenticated' }))],
    });
    const uc = new CreatePullRequestUseCase(external, repo, new FakeLoggerPort());

    const result = await uc.execute({
      sprint,
      cwd,
      base: 'main',
      title: 't',
      body: 'b',
      draft: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('storage-error');
  });
});
