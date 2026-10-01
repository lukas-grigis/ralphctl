/**
 * First-run behaviour of the create-project wizard through the real chrome: inline validation,
 * the escape hatches (esc at the stack root, `h` on prompt-less steps) and the storage-error
 * round trip that keeps every earlier value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeProject } from '@tests/fixtures/domain.ts';
import { CreateProjectView } from '@src/application/ui/tui/views/create-project-view.tsx';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { CTRL_U, ENTER, ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { mountFrame, StubView, type AppFrame } from '@tests/integration/application/ui/tui/_app-frame.tsx';
import { stripAnsi } from '@tests/integration/application/ui/tui/_harness.tsx';

const frameText = (f: AppFrame): string => stripAnsi(f.result.lastFrame() ?? '');
const press = async (f: AppFrame, keys: string, ms = 60): Promise<void> => {
  f.result.stdin.write(keys);
  await tick(ms);
};

const mount = (save: ProjectRepository['save'], existing: readonly Project[] = []): AppFrame =>
  mountFrame({
    columns: 100,
    rows: 40,
    initial: { id: 'create-project' },
    deps: {
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
      projectRepo: { save, list: async () => Result.ok(existing) },
    } as unknown as AppDeps,
    renderRoute: (entry) => (entry.id === 'create-project' ? <CreateProjectView /> : <StubView id={entry.id} />),
  });

describe('CreateProjectView — first run', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ralphctl-cp-first-'));
    await fs.mkdir(join(root, 'repo'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('runs outside the sections: no tab bar, and esc on the first step lands in Work', async () => {
    const f = mount(vi.fn() as unknown as ProjectRepository['save']);
    await tick(80);
    expect(f.router().activeSection).toBe('none');
    expect(frameText(f)).not.toContain('1 Work');

    await press(f, ESC, 80);
    expect(f.router().current.id).toBe('home');
    expect(f.router().activeSection).toBe('work');
    f.result.unmount();
  });

  it('rejects an empty name inline and keeps focus', async () => {
    const f = mount(vi.fn() as unknown as ProjectRepository['save']);
    await tick(80);
    await press(f, ENTER);
    expect(frameText(f)).toContain('✗ Name is required');
    expect(frameText(f)).toContain('Project display name');
    await press(f, 'Acme');
    await press(f, ENTER);
    expect(frameText(f)).toContain('Project slug');
    f.result.unmount();
  });

  it('shows the Slug.parse error before submit and blocks ↵', async () => {
    const f = mount(vi.fn() as unknown as ProjectRepository['save']);
    await tick(80);
    await press(f, 'Acme');
    await press(f, ENTER, 100);
    await press(f, '_');
    expect(frameText(f)).toContain('✗ slug must be lowercase alphanumeric');
    await press(f, ENTER);
    expect(frameText(f)).toContain('Project slug');
    f.result.unmount();
  });

  it('rejects a slug another project already uses inline, including the blank default', async () => {
    const save = vi.fn() as unknown as ProjectRepository['save'];
    const f = mount(save, [makeProject({ slug: 'acme' })]);
    await tick(80);
    await press(f, 'Acme');
    await press(f, ENTER, 100);
    expect(frameText(f)).toContain("✗ slug 'acme' is already used by another project");
    await press(f, ENTER);
    expect(frameText(f)).toContain('Project slug');
    await press(f, CTRL_U);
    expect(frameText(f)).toContain("✗ slug 'acme' is already used by another project");
    await press(f, 'acme-2');
    expect(frameText(f)).not.toContain('already used');
    await press(f, ENTER, 100);
    expect(frameText(f)).toContain('Description');
    f.result.unmount();
  });

  it('rejects a path that does not exist inline', async () => {
    const f = mount(vi.fn() as unknown as ProjectRepository['save']);
    await tick(80);
    await press(f, 'Acme');
    await press(f, ENTER, 100);
    await press(f, ENTER, 100);
    await press(f, ENTER, 100);
    await press(f, 't', 100);
    await press(f, CTRL_U);
    await press(f, join(root, 'missing'));
    await press(f, ENTER, 100);
    expect(frameText(f)).toMatch(/does not\s+exist/);
    expect(frameText(f)).toContain('Path');
    f.result.unmount();
  });

  const walkToConfirm = async (f: AppFrame): Promise<void> => {
    await tick(80);
    await press(f, 'Acme');
    await press(f, ENTER, 100);
    await press(f, ENTER, 100);
    await press(f, ENTER, 100);
    await press(f, 't', 100);
    await press(f, CTRL_U);
    await press(f, join(root, 'repo'));
    await press(f, ENTER, 150);
    await press(f, ENTER, 100);
  };

  it('returns from a storage error to the confirm step with values intact, and h reaches Work while saving', async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce(Result.error({ message: 'disk full' }))
      .mockReturnValueOnce(new Promise(() => undefined)) as unknown as ProjectRepository['save'];
    const f = mount(save);
    await walkToConfirm(f);
    expect(frameText(f)).toContain('Save this project?');
    await press(f, ENTER, 150);
    expect(frameText(f)).toContain('✗ disk full');

    await press(f, ESC, 100);
    const back = frameText(f);
    expect(back).toContain('Save this project?');
    expect(back).toContain('Acme');
    expect(back).toContain(join(root, 'repo'));

    // Second save never settles: the saving step holds no prompt claim, so `h` still works.
    await press(f, ENTER, 150);
    expect(frameText(f)).toContain('saving project');
    await press(f, 'h', 100);
    expect(f.router().current.id).toBe('home');
    expect(f.router().activeSection).toBe('work');
    f.result.unmount();
  });

  it('`h` reaches Work from the error step', async () => {
    const save = vi
      .fn()
      .mockResolvedValue(Result.error({ message: 'disk full' })) as unknown as ProjectRepository['save'];
    const f = mount(save);
    await walkToConfirm(f);
    await press(f, ENTER, 150);
    expect(frameText(f)).toContain('✗ disk full');
    await press(f, 'h', 100);
    expect(f.router().current.id).toBe('home');
    f.result.unmount();
  });
});
