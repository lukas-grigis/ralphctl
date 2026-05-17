import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import { absolutePath, makeApprovedTicket, makeDraftSprint } from '@tests/fixtures/domain.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { createExportRequirementsFlow } from '@src/application/flows/export-requirements/flow.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

const fakeSprintRepo = (sprint: Sprint): SprintRepository =>
  ({
    async findById(id: SprintId) {
      if (id === sprint.id) return Result.ok(sprint);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
  }) as SprintRepository;

const inMemoryWriteFile = (): { writeFile: WriteFile; writes: Array<{ path: AbsolutePath; content: string }> } => {
  const writes: Array<{ path: AbsolutePath; content: string }> = [];
  const writeFile: WriteFile = async (path, content) => {
    writes.push({ path, content });
    return Result.ok(undefined);
  };
  return { writeFile, writes };
};

describe('export-requirements flow — happy path', () => {
  it('writes the rendered markdown to the requested output path', async () => {
    const ticket = makeApprovedTicket({ title: 'export me', requirements: '- AC' });
    const sprint = makeDraftSprint({ tickets: [ticket] });
    const writer = inMemoryWriteFile();
    const outputPath = absolutePath('/tmp/req.md');

    const flow = createExportRequirementsFlow({
      sprintRepo: fakeSprintRepo(sprint),
      writeFile: writer.writeFile,
    });
    const result = await flow.execute({ input: { sprintId: sprint.id, outputPath } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.output!.outputPath).toBe(outputPath);
    expect(result.value.ctx.output!.byteCount).toBeGreaterThan(0);
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]?.path).toBe(outputPath);
    expect(writer.writes[0]?.content).toContain('## export me');
    expect(writer.writes[0]?.content).toContain('- AC');
  });

  it('surfaces NotFoundError when the sprint does not exist', async () => {
    const sprint = makeDraftSprint({ tickets: [] });
    const writer = inMemoryWriteFile();
    const outputPath = absolutePath('/tmp/req-missing.md');

    const flow = createExportRequirementsFlow({
      sprintRepo: fakeSprintRepo(sprint),
      writeFile: writer.writeFile,
    });
    const result = await flow.execute({
      input: { sprintId: 'nonexistent' as unknown as SprintId, outputPath },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(NotFoundError);
    expect(writer.writes).toHaveLength(0);
  });
});
