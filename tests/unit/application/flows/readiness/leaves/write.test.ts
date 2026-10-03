import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { writeReadinessLeaf } from '@src/application/flows/readiness/leaves/write.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { absolutePath, FIXED_PROJECT_ID, isoTimestamp } from '@tests/fixtures/domain.ts';

const NOW = isoTimestamp('2026-05-30T10:00:00.000Z');

const ctxFor = (targetPath: AbsolutePath): ReadinessCtx => ({
  projectId: FIXED_PROJECT_ID,
  tools: ['claude-code'],
  entries: { 'claude-code': { accepted: true, proposal: { proposedContent: '# new\n', targetPath } } },
});

const unreadableFilesTestable = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('writeReadinessLeaf backup', () => {
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
    writeReadinessLeaf({ writeFile, logger: noopLogger, clock: () => NOW }, 'claude-code').execute(ctxFor(targetPath));

  it.skipIf(!unreadableFilesTestable)(
    'refuses to overwrite an existing target it cannot read for backup, leaving it untouched',
    async () => {
      const target = join(String(root.root), 'CLAUDE.md');
      await fs.writeFile(target, '# old\n', 'utf8');
      await fs.chmod(target, 0o000);

      try {
        const result = await run(absolutePath(target));

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.error).toBeInstanceOf(StorageError);
        expect(writeFile).not.toHaveBeenCalled();
      } finally {
        await fs.chmod(target, 0o644);
      }
      expect(await fs.readFile(target, 'utf8')).toBe('# old\n');
    }
  );

  it('writes a .bak backup of an existing target before the new content', async () => {
    const target = join(String(root.root), 'CLAUDE.md');
    await fs.writeFile(target, '# old\n', 'utf8');

    const result = await run(absolutePath(target));

    expect(result.ok).toBe(true);
    expect(writes).toEqual([`${target}.bak.2026-05-30T10-00-00.000Z`, target]);
  });

  it('writes no backup when the target is absent', async () => {
    const target = join(String(root.root), 'CLAUDE.md');

    const result = await run(absolutePath(target));

    expect(result.ok).toBe(true);
    expect(writes).toEqual([target]);
  });
});
