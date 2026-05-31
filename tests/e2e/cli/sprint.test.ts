import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { makeActiveSprint, makeDraftSprint, makeReviewSprint } from '@tests/fixtures/domain.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl sprint', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  describe('list', () => {
    it('reports the empty state on a fresh install', async () => {
      const result = await runCliCaptured(cli, ['sprint', 'list']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no sprints yet');
    });

    it('lists each sprint with id + slug + status + name', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const sprint = makeDraftSprint();
      await repo.save(sprint);

      const result = await runCliCaptured(cli, ['sprint', 'list']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(String(sprint.id));
      expect(result.stdout).toContain(sprint.name);
      expect(result.stdout).toContain('[draft');
    });
  });

  describe('show <id>', () => {
    it('prints the sprint as JSON', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const sprint = makeDraftSprint();
      await repo.save(sprint);

      const result = await runCliCaptured(cli, ['sprint', 'show', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { readonly id: string; readonly status: string };
      expect(parsed.id).toBe(String(sprint.id));
      expect(parsed.status).toBe('draft');
    });

    it('exits 1 on an invalid sprint id', async () => {
      const result = await runCliCaptured(cli, ['sprint', 'show', 'not-a-uuid']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid sprint id');
    });
  });

  describe('remove <id>', () => {
    it('full CRUD round-trip — seed, list, remove, list-empty', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const sprint = makeDraftSprint();
      await repo.save(sprint);

      const removed = await runCliCaptured(cli, ['sprint', 'remove', String(sprint.id)]);
      expect(removed.exitCode).toBe(0);
      expect(removed.stdout).toContain(`removed sprint ${String(sprint.id)}`);

      const listAfterRemove = await runCliCaptured(cli, ['sprint', 'list']);
      expect(listAfterRemove.stdout).toContain('no sprints yet');
    });
  });

  describe('close <id>', () => {
    it('transitions a review sprint to done and persists it', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const sprint = makeReviewSprint();
      await repo.save(sprint);

      const result = await runCliCaptured(cli, ['sprint', 'close', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`closed sprint '${String(sprint.slug)}'`);

      const reloaded = await repo.findById(sprint.id);
      expect(reloaded.ok).toBe(true);
      if (reloaded.ok) expect(reloaded.value.status).toBe('done');
    });

    it('rejects an active sprint with InvalidStateError', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const sprint = makeActiveSprint();
      await repo.save(sprint);

      const result = await runCliCaptured(cli, ['sprint', 'close', String(sprint.id)]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("'active'");
    });

    it('exits 1 on an invalid sprint id', async () => {
      const result = await runCliCaptured(cli, ['sprint', 'close', 'not-a-uuid']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid sprint id');
    });
  });
});
