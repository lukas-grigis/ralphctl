/**
 * End-to-end test for the add-repository wizard. Steps through path → name → confirm and
 * asserts projectRepo.save was called with the existing project plus the new repository.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AddRepositoryView } from '@src/application/ui/tui/views/add-repository-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import { makeProject } from '@tests/fixtures/domain.ts';
import { CTRL_U, ENTER, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

describe('AddRepositoryView — wizard e2e', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ralphctl-arve2e-'));
    await fs.mkdir(join(root, 'extra-repo'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('appends a second repository to the project on confirm', async () => {
    const project = makeProject({ displayName: 'Mainline' });
    const save = vi.fn(async (p: Project) => {
      void p;
      return Result.ok(undefined);
    });
    const projectRepo: ProjectRepository = {
      async findById() {
        return Result.ok(project);
      },
      save,
    } as unknown as ProjectRepository;
    const deps: AppDeps = { projectRepo } as unknown as AppDeps;

    const { result } = renderView(<AddRepositoryView />, {
      deps,
      initial: { id: 'add-repository', props: { projectId: project.id } },
    });
    await tick(40);

    // Step 1: path picker — use `t` typing overlay for determinism.
    result.stdin.write('t');
    await tick(80);
    result.stdin.write(CTRL_U);
    await tick(40);
    result.stdin.write(join(root, 'extra-repo'));
    await tick(40);
    result.stdin.write(ENTER);
    await tick(200);

    // Step 2: name — accept default (basename = "extra-repo").
    result.stdin.write(ENTER);
    await tick(200);

    // Step 3: confirm. defaultYes=true, so Enter commits.
    result.stdin.write(ENTER);
    await tick(300);

    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]?.[0];
    expect(saved?.repositories).toHaveLength(project.repositories.length + 1);
    const added = saved?.repositories[saved.repositories.length - 1];
    expect(added?.name).toBe('extra-repo');
    expect(String(added?.path)).toContain('extra-repo');

    result.unmount();
  });
});
