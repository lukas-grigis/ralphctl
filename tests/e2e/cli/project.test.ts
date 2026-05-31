import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { makeProject, projectId } from '@tests/fixtures/domain.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl project', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  describe('list', () => {
    it('reports the empty state on a fresh install', async () => {
      const result = await runCliCaptured(cli, ['project', 'list']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no projects yet');
    });

    it('lists each registered project with id + slug + name + repo count', async () => {
      const repo = createFsProjectRepository({ root: cli.paths.dataRoot });
      const a = makeProject({ id: projectId('01900000-0000-7000-8000-00000000aaaa'), displayName: 'Alpha' });
      const b = makeProject({ id: projectId('01900000-0000-7000-8000-00000000bbbb'), displayName: 'Beta' });
      await repo.save(a);
      await repo.save(b);

      const result = await runCliCaptured(cli, ['project', 'list']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Alpha');
      expect(result.stdout).toContain('Beta');
      expect(result.stdout).toContain(String(a.id));
      expect(result.stdout).toContain(String(b.id));
    });
  });

  describe('show <id>', () => {
    it('prints the project as JSON', async () => {
      const repo = createFsProjectRepository({ root: cli.paths.dataRoot });
      const project = makeProject({ displayName: 'Demo' });
      await repo.save(project);

      const result = await runCliCaptured(cli, ['project', 'show', String(project.id)]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { readonly id: string; readonly displayName: string };
      expect(parsed.id).toBe(String(project.id));
      expect(parsed.displayName).toBe('Demo');
    });

    it('exits 1 when the project does not exist', async () => {
      const result = await runCliCaptured(cli, ['project', 'show', '01900000-0000-7000-8000-000000000999']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('error:');
    });

    it('exits 1 on an invalid id shape', async () => {
      const result = await runCliCaptured(cli, ['project', 'show', 'not-a-uuid']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid project id');
    });
  });

  describe('remove <id>', () => {
    it('full CRUD round-trip — seed, list, remove, list-empty', async () => {
      const repo = createFsProjectRepository({ root: cli.paths.dataRoot });
      const project = makeProject({ displayName: 'Round Trip' });
      await repo.save(project);

      const listAfterSeed = await runCliCaptured(cli, ['project', 'list']);
      expect(listAfterSeed.stdout).toContain('Round Trip');

      const removed = await runCliCaptured(cli, ['project', 'remove', String(project.id)]);
      expect(removed.exitCode).toBe(0);
      expect(removed.stdout).toContain(`removed project ${String(project.id)}`);

      const listAfterRemove = await runCliCaptured(cli, ['project', 'list']);
      expect(listAfterRemove.exitCode).toBe(0);
      expect(listAfterRemove.stdout).toContain('no projects yet');
    });
  });
});
