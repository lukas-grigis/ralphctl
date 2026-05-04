/**
 * `exportSprintRequirementsLeaf` tests.
 *
 * The leaf calls `resolveStoragePaths()` inside its execute body to derive
 * the target path — it reads `process.env.RALPHCTL_ROOT` at call time.
 * We point that variable at a stable, test-controlled prefix before each
 * execute call so path assertions are predictable and deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeWriteContextFilePort } from '@src/business/_test-fakes/fake-write-context-file-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { makeApprovedTicket, makeSprint, makeTicket, sprintId } from '@src/application/_test-fakes/fixtures.ts';
import { exportSprintRequirementsLeaf, type ExportSprintRequirementsCtx } from './export-sprint-requirements.ts';

const TEST_ROOT = '/tmp/ralphctl-export-req-test';

/** Set RALPHCTL_ROOT before each test so `resolveStoragePaths()` uses a deterministic prefix. */
beforeEach(() => {
  process.env['RALPHCTL_ROOT'] = TEST_ROOT;
});
afterEach(() => {
  delete process.env['RALPHCTL_ROOT'];
});

function makeCtx(sprint: ReturnType<typeof makeSprint>): ExportSprintRequirementsCtx {
  return { sprintId: sprint.id, sprint };
}

describe('exportSprintRequirementsLeaf', () => {
  describe('happy path', () => {
    it('writes requirements.json under <sprintDir>/ for the given sprintId', async () => {
      const writeContextFile = new FakeWriteContextFilePort();
      const leaf = exportSprintRequirementsLeaf<ExportSprintRequirementsCtx>({ writeContextFile });

      const sprint = makeSprint();
      const result = await leaf.execute(makeCtx(sprint));

      expect(result.ok).toBe(true);
      expect(writeContextFile.writes).toHaveLength(1);

      const write = writeContextFile.writes[0];
      // The target path must contain the sprint id and end with requirements.json.
      expect(String(write?.path)).toContain(String(sprint.id));
      expect(String(write?.path)).toContain('requirements.json');
    });

    it('writes valid JSON whose sprintId and sprintName match the sprint', async () => {
      const writeContextFile = new FakeWriteContextFilePort();
      const leaf = exportSprintRequirementsLeaf<ExportSprintRequirementsCtx>({ writeContextFile });

      const sprint = makeSprint({ name: 'Quality Sprint', slug: 'quality' });
      await leaf.execute(makeCtx(sprint));

      const body = writeContextFile.writes[0]?.content ?? '';
      const parsed: { sprintId: string; sprintName: string; tickets: unknown[] } = JSON.parse(body) as {
        sprintId: string;
        sprintName: string;
        tickets: unknown[];
      };
      expect(parsed.sprintId).toBe(String(sprint.id));
      expect(parsed.sprintName).toBe('Quality Sprint');
    });

    it('only includes approved tickets in the written aggregate', async () => {
      const writeContextFile = new FakeWriteContextFilePort();
      const leaf = exportSprintRequirementsLeaf<ExportSprintRequirementsCtx>({ writeContextFile });

      const approved = makeApprovedTicket({ title: 'Approved ticket', requirements: 'must do X' });
      const pending = makeTicket({ title: 'Pending ticket' });
      const base = makeSprint();
      const withApproved = base.addTicket(approved);
      if (!withApproved.ok) throw new Error('addTicket(approved) failed');
      const withPending = withApproved.value.addTicket(pending);
      if (!withPending.ok) throw new Error('addTicket(pending) failed');
      const sprint = withPending.value;

      await leaf.execute(makeCtx(sprint));

      const body = writeContextFile.writes[0]?.content ?? '';
      const parsed: { tickets: { title: string }[] } = JSON.parse(body) as { tickets: { title: string }[] };
      expect(parsed.tickets).toHaveLength(1);
      expect(parsed.tickets[0]?.title).toBe('Approved ticket');
    });

    it('writes an empty tickets array when no tickets are approved yet', async () => {
      const writeContextFile = new FakeWriteContextFilePort();
      const leaf = exportSprintRequirementsLeaf<ExportSprintRequirementsCtx>({ writeContextFile });

      const sprint = makeSprint();

      await leaf.execute(makeCtx(sprint));

      const body = writeContextFile.writes[0]?.content ?? '';
      const parsed: { tickets: unknown[] } = JSON.parse(body) as { tickets: unknown[] };
      expect(parsed.tickets).toHaveLength(0);
    });

    it('returns the ctx unchanged after writing (output is identity)', async () => {
      const writeContextFile = new FakeWriteContextFilePort();
      const leaf = exportSprintRequirementsLeaf<ExportSprintRequirementsCtx>({ writeContextFile });

      const sprint = makeSprint();
      const ctx = makeCtx(sprint);

      const result = await leaf.execute(ctx);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.ctx).toBe(ctx);
    });

    it('records the correct step name and completed status in the trace', async () => {
      const writeContextFile = new FakeWriteContextFilePort();
      const leaf = exportSprintRequirementsLeaf<ExportSprintRequirementsCtx>({ writeContextFile });

      const sprint = makeSprint();
      const result = await leaf.execute(makeCtx(sprint));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.trace).toHaveLength(1);
      expect(result.value.trace[0]?.stepName).toBe('export-sprint-requirements');
      expect(result.value.trace[0]?.status).toBe('completed');
    });

    it('respects a custom leaf name when provided', async () => {
      const writeContextFile = new FakeWriteContextFilePort();
      const leaf = exportSprintRequirementsLeaf<ExportSprintRequirementsCtx>(
        { writeContextFile },
        'custom-export-requirements'
      );

      const sprint = makeSprint();
      const result = await leaf.execute(makeCtx(sprint));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.trace[0]?.stepName).toBe('custom-export-requirements');
    });

    it('uses sprintId from ctx (not sprint.id) to construct the target path', async () => {
      const writeContextFile = new FakeWriteContextFilePort();
      const leaf = exportSprintRequirementsLeaf<ExportSprintRequirementsCtx>({ writeContextFile });

      const id = sprintId('20260501-100000-unique');
      const sprint = makeSprint({ slug: 'unique' });
      // supply a ctx sprintId that is different from sprint.id to verify which one drives the path
      const ctx: ExportSprintRequirementsCtx = { sprintId: id, sprint };

      await leaf.execute(ctx);

      const write = writeContextFile.writes[0];
      expect(String(write?.path)).toContain('20260501-100000-unique');
    });
  });

  describe('error path', () => {
    it('surfaces the StorageError verbatim when writeContextFile.write fails', async () => {
      const writeError = new StorageError({ subCode: 'io', message: 'permission denied' });
      const writeContextFile = new FakeWriteContextFilePort({ failWith: writeError });
      const leaf = exportSprintRequirementsLeaf<ExportSprintRequirementsCtx>({ writeContextFile });

      const sprint = makeSprint();
      const result = await leaf.execute(makeCtx(sprint));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.error).toBe(writeError);
      expect(result.error.trace[0]?.status).toBe('failed');
    });

    it('still attempts the write (FakeWriteContextFilePort captures it) before surfacing the error', async () => {
      const writeError = new StorageError({ subCode: 'io', message: 'disk full' });
      const writeContextFile = new FakeWriteContextFilePort({ failWith: writeError });
      const leaf = exportSprintRequirementsLeaf<ExportSprintRequirementsCtx>({ writeContextFile });

      const sprint = makeSprint();
      await leaf.execute(makeCtx(sprint));

      // The port was called exactly once — the leaf attempted the write.
      expect(writeContextFile.writes).toHaveLength(1);
    });
  });

  describe('missing ctx guard', () => {
    // Note: the Leaf framework catches throws from the input() function and
    // wraps them in Result.error — the promise resolves, it does not reject.
    it('fails the step when ctx.sprint is missing', async () => {
      const leaf = exportSprintRequirementsLeaf<ExportSprintRequirementsCtx>({
        writeContextFile: new FakeWriteContextFilePort(),
      });
      const id = sprintId('20260501-120000-guard-test');
      const result = await leaf.execute({ sprintId: id });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.trace[0]?.status).toBe('failed');
      expect(result.error.error.message).toMatch(/ctx.sprint must be set/);
    });
  });
});
