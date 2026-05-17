import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realpath } from 'node:fs/promises';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { ensureProgressFileLeaf } from '@src/application/flows/implement/leaves/ensure-progress-file.ts';

describe('ensureProgressFileLeaf', () => {
  let dir: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-progress-'));
    dir = await realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates the file with a header when missing and writes the path onto ctx', async () => {
    const path = absolutePath(join(dir, 'progress.md'));
    const leafEl = ensureProgressFileLeaf(path);

    const result = await leafEl.execute({ sprintId: 'sprint-x' as SprintId } satisfies ImplementCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx.progressFile).toBe(path);
    }
    const body = await fs.readFile(String(path), 'utf8');
    expect(body).toContain('# Sprint Progress');
  });

  it('is idempotent — pre-existing file is left untouched', async () => {
    const path = absolutePath(join(dir, 'progress.md'));
    await fs.writeFile(String(path), 'EXISTING CONTENT');
    const leafEl = ensureProgressFileLeaf(path);

    const result = await leafEl.execute({ sprintId: 'sprint-x' as SprintId } satisfies ImplementCtx);
    expect(result.ok).toBe(true);

    const body = await fs.readFile(String(path), 'utf8');
    expect(body).toBe('EXISTING CONTENT');
  });
});
