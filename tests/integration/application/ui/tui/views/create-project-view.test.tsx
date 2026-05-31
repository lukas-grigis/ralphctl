/**
 * End-to-end test for the create-project wizard. Steps through every prompt and asserts
 * projectRepo.save is called with an aggregate that matches the typed inputs. Verifies the
 * integration between TextPrompt buffer + per-step key + the wizard's submit pipeline that
 * earlier sessions accidentally regressed (closure-vs-state buffer reads, leaking hotkeys,
 * buffer-bleed between steps).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { CreateProjectView } from '@src/application/ui/tui/views/create-project-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import { CTRL_U, ENTER, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

describe('CreateProjectView — wizard e2e', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ralphctl-cpe2e-'));
    await fs.mkdir(join(root, 'main-repo'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('walks every step and saves a Project with the typed inputs', async () => {
    const save = vi.fn(async (project: Project) => {
      void project;
      return Result.ok(undefined);
    });
    const projectRepo = { save } as unknown as ProjectRepository;
    const deps: AppDeps = { projectRepo } as unknown as AppDeps;

    const { result } = renderView(<CreateProjectView />, { deps, initial: { id: 'create-project' } });
    await tick(80);

    // Step 1: display name.
    result.stdin.write('Mainline');
    await tick(60);
    result.stdin.write(ENTER);
    await tick(200);

    // Step 2: slug — accept the kebab-case default.
    result.stdin.write(ENTER);
    await tick(200);

    // Step 3: description — skip.
    result.stdin.write(ENTER);
    await tick(200);

    // Step 4: repo path picker — cursor defaults to [Select this directory]. Navigate into
    // main-repo (down once to skip parent / [Select], then once more to land on main-repo)
    // then Enter to descend, then Enter to commit.
    // The harness's initial cwd is process.cwd(); we type instead via `t` to drop into a text
    // entry overlay for determinism.
    result.stdin.write('t');
    await tick(80);
    // Buffer is preseeded with the picker's cwd — clear and type our path.
    result.stdin.write(CTRL_U);
    await tick(40);
    result.stdin.write(join(root, 'main-repo'));
    await tick(40);
    result.stdin.write(ENTER);
    await tick(250);

    // Step 5: repo name — accept default (basename of path).
    result.stdin.write(ENTER);
    await tick(200);

    // Step 6: confirm. Default focus is Yes; press Enter.
    result.stdin.write(ENTER);
    await tick(300);

    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]?.[0];
    expect(saved).toBeDefined();
    expect(saved?.displayName).toBe('Mainline');
    expect(saved?.slug).toBe('mainline');
    expect(saved?.repositories).toHaveLength(1);
    expect(saved?.repositories[0]?.name).toBe('main-repo');
    expect(String(saved?.repositories[0]?.path)).toContain('main-repo');

    result.unmount();
  });
});
