import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { distillWriteLeaf } from '@src/application/flows/_shared/memory/distill-write.ts';
import type { DistillLearningsCtx } from '@src/application/flows/_shared/memory/distill-ctx.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { absolutePath, isoTimestamp, makeRepository } from '@tests/fixtures/domain.ts';

const NOW = isoTimestamp('2026-05-30T10:00:00.000Z');

const ctxFor = (targetPath: AbsolutePath): DistillLearningsCtx => ({
  distillRequested: true,
  repository: makeRepository(),
  entries: { 'claude-code': { accepted: true, proposedContent: '# new\n', targetPath } },
});

describe('distillWriteLeaf backup', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let writes: string[];
  let writeFile: WriteFile;

  beforeEach(async () => {
    root = await makeTmpRoot();
    writes = [];
    writeFile = vi.fn<WriteFile>(async (path) => {
      writes.push(String(path));
      return Result.ok(undefined);
    });
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const run = (targetPath: AbsolutePath) =>
    distillWriteLeaf({ writeFile, logger: noopLogger, clock: () => NOW }, 'claude-code').execute(ctxFor(targetPath));

  it('refuses to overwrite when the existing target cannot be read for backup', async () => {
    // A directory at the target path makes readFile throw EISDIR — present but unreadable.
    const target = join(String(root.root), 'CLAUDE.md');
    await fs.mkdir(target);

    const result = await run(absolutePath(target));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(StorageError);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('writes a .bak backup of an existing target before the new content', async () => {
    const target = join(String(root.root), 'CLAUDE.md');
    await fs.writeFile(target, '# old\n', 'utf8');

    const result = await run(absolutePath(target));

    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain(`${target}.bak.`);
    expect(writes[1]).toBe(target);
  });

  it('writes no backup when the target is absent', async () => {
    const target = join(String(root.root), 'CLAUDE.md');

    const result = await run(absolutePath(target));

    expect(result.ok).toBe(true);
    expect(writes).toEqual([target]);
  });
});
