/**
 * End-to-end test for the create-project wizard. Steps through every prompt and asserts
 * projectRepo.save is called with an aggregate that matches the typed inputs. Verifies the
 * integration between TextPrompt buffer + per-step key + the wizard's submit pipeline that
 * earlier sessions accidentally regressed (closure-vs-state buffer reads, leaking hotkeys,
 * buffer-bleed between steps).
 */

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { CreateProjectView } from '@src/application/ui/tui/views/create-project-view.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useOverlayState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useGlobalKeys } from '@src/application/ui/tui/runtime/use-global-keys.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import { makeProject } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createRealFsApp } from '@tests/helpers/real-fs-app.ts';
import { CTRL_U, ENTER, ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitFor, waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, waitForViewReady, type HarnessApi } from '@tests/integration/application/ui/tui/_harness.tsx';

// Types `name`, accepts the default slug, skips the description, enters `repoPath`, accepts the
// default repo name and confirms.
const walkWizard = async (result: HarnessApi['result'], name: string, repoPath: string): Promise<void> => {
  // Match the prompt's literal copy — the view renders "Project display name".
  await waitForViewReady(result, (f) => f.includes('Project display name'));

  result.stdin.write(name);
  await tick(60);
  result.stdin.write(ENTER);
  await tick(200);

  // Slug — accept the kebab-case default.
  result.stdin.write(ENTER);
  await tick(200);

  // Description — skip.
  result.stdin.write(ENTER);
  await tick(200);

  // Repo path picker — `t` drops into a text-entry overlay preseeded with the cwd; clear it and
  // type the path for determinism.
  result.stdin.write('t');
  await tick(80);
  result.stdin.write(CTRL_U);
  await tick(40);
  result.stdin.write(repoPath);
  await tick(40);
  result.stdin.write(ENTER);
  await tick(250);

  // Repo name — accept default (basename of path).
  result.stdin.write(ENTER);
  await tick(200);

  // Confirm. Default focus is Yes.
  result.stdin.write(ENTER);
  await tick(300);
};

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
    const projectRepo = { save, list: async () => Result.ok([]) } as unknown as ProjectRepository;
    const deps: AppDeps = { projectRepo, logger: noopLogger } as unknown as AppDeps;

    const { result } = renderView(<CreateProjectView />, { deps, initial: { id: 'create-project' } });
    await walkWizard(result, 'Mainline', join(root, 'main-repo'));

    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]?.[0];
    expect(saved).toBeDefined();
    expect(saved?.displayName).toBe('Mainline');
    expect(saved?.slug).toBe('mainline');
    expect(saved?.repositories).toHaveLength(1);
    expect(saved?.repositories[0]?.name).toBe('main-repo');
    expect(String(saved?.repositories[0]?.path)).toContain('main-repo');
  });

  it('rejects a slug already held by a stored project and writes nothing', async () => {
    const app = await createRealFsApp();
    try {
      const seeded = await app.deps.projectRepo.save(makeProject({ slug: 'mainline', displayName: 'Mainline' }));
      expect(seeded.ok).toBe(true);

      const { result } = renderView(<CreateProjectView />, { deps: app.deps, initial: { id: 'create-project' } });
      await walkWizard(result, 'Mainline', join(root, 'main-repo'));

      expect(result.lastFrame()).toContain("slug 'mainline' is already used by another project");
      expect(await fs.readdir(app.projectsDir)).toHaveLength(1);

      result.unmount();
    } finally {
      await app.cleanup();
    }
  });
});

// Mounts the wizard the way App does: pushed over home, under the real global key handler.
const PushedCreateProject = (): React.JSX.Element => {
  const router = useRouter();
  const ui = useOverlayState();
  useGlobalKeys({ disabled: ui.promptActive });
  const [pushed, setPushed] = useState(false);
  useEffect(() => {
    router.push({ id: 'create-project' });
    setPushed(true);
    // Push exactly once on mount.
  }, []);
  return pushed ? <CreateProjectView /> : <Text>mounting</Text>;
};

describe('CreateProjectView — failure steps always have an exit', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ralphctl-cpexit-'));
    await fs.mkdir(join(root, 'main-repo'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('esc on a taken slug returns to the slug step with the rest of the input kept', async () => {
    const app = await createRealFsApp();
    try {
      const seeded = await app.deps.projectRepo.save(makeProject({ slug: 'mainline', displayName: 'Mainline' }));
      expect(seeded.ok).toBe(true);

      const { result, routeIds } = renderView(<PushedCreateProject />, { deps: app.deps, initial: { id: 'home' } });
      await walkWizard(result, 'Mainline', join(root, 'main-repo'));
      await waitFor(() => expect(result.lastFrame()).toContain('already used by another project'));

      result.stdin.write(ESC);
      await waitFor(() => expect(result.lastFrame()).toContain('Project slug'));
      expect(result.lastFrame()).not.toContain('already used');
      expect(routeIds().at(-1)).toBe('create-project');

      result.stdin.write(CTRL_U);
      await tick(40);
      result.stdin.write('mainline-two');
      await tick(60);
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toContain('Description'));
      result.stdin.write(ENTER);
      // The picker reopens on the repo picked before — `t` + enter takes it as-is.
      await waitFor(() => expect(result.lastFrame()).toContain('Repository directory'));
      result.stdin.write('t');
      await tick(80);
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toContain('Repository name'));
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toContain('Save this project?'));
      expect(result.lastFrame()).toContain('main-repo');
      result.stdin.write(ENTER);

      await waitFor(async () => expect(await fs.readdir(app.projectsDir)).toHaveLength(2));
      const listed = await app.deps.projectRepo.list();
      const created = listed.ok ? listed.value.find((p) => p.slug === 'mainline-two') : undefined;
      expect(created?.displayName).toBe('Mainline');
      expect(String(created?.repositories[0]?.path)).toContain('main-repo');
    } finally {
      await app.cleanup();
    }
  });

  it('esc after a failed save returns to the confirm step so a retry needs no retyping', async () => {
    const save = vi.fn(async () => Result.error(new StorageError({ subCode: 'io', message: 'disk full' })));
    const projectRepo = { save, list: async () => Result.ok([]) } as unknown as ProjectRepository;
    const deps: AppDeps = { projectRepo, logger: noopLogger } as unknown as AppDeps;

    const { result, routeIds } = renderView(<PushedCreateProject />, { deps, initial: { id: 'home' } });
    await walkWizard(result, 'Mainline', join(root, 'main-repo'));
    await waitFor(() => expect(result.lastFrame()).toContain('disk full'));

    result.stdin.write(ESC);
    await waitFor(() => expect(result.lastFrame()).toContain('Save this project?'));
    expect(result.lastFrame()).toContain('Mainline');
    expect(routeIds().at(-1)).toBe('create-project');

    result.stdin.write(ENTER);
    await waitForPredicate(() => save.mock.calls.length === 2);
  });
});
