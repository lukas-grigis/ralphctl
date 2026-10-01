import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { appendJournalSeparatorLeaf } from '@src/application/flows/_shared/progress/append-journal-separator.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { absolutePath, FIXED_NOW } from '@tests/fixtures/domain.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

/** A lifecycle separator also moves the derived header's `State:` line, so progress.md never lags the sprint. */

const JOURNAL =
  '# Sprint: demo\n\n## Status\n\n- State: active\n- Branch: —\n\n## Task: t — Attempt 1 · id:t-1\n\nbody\n';

describe('appendJournalSeparatorLeaf', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpRoot>>;
  beforeEach(async () => {
    tmp = await makeTmpRoot();
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  const run = async (status: 'activated' | 'review' | 'closed', withWriter: boolean): Promise<string> => {
    const progressFile = absolutePath(join(String(tmp.root), 'progress.md'));
    const leaf = appendJournalSeparatorLeaf<Record<string, never>>(
      {
        appendFile: createAppendFile(),
        ...(withWriter ? { writeFile: createAtomicWriteFile() } : {}),
        clock: () => FIXED_NOW,
        logger: noopLogger,
      },
      { progressFile, status, name: 'sep' }
    );
    const runner = createRunner({ id: 'r-sep', element: leaf, initialCtx: {} });
    await runner.start();
    expect(runner.status).toBe('completed');
    return fs.readFile(String(progressFile), 'utf8');
  };

  it.each([
    ['review', 'review', 'transitioned to review'],
    ['closed', 'done', 'closed'],
    ['activated', 'active', 'activated'],
  ] as const)('%s rewrites State to %s and appends the separator', async (status, state, label) => {
    await fs.writeFile(join(String(tmp.root), 'progress.md'), JOURNAL.replace('active', 'planned'), 'utf8');
    const out = await run(status, true);
    expect(out).toContain(`- State: ${state}\n`);
    expect(out).toContain('## Task: t — Attempt 1 · id:t-1\n\nbody\n');
    expect(out.trimEnd().endsWith(`_Sprint ${label} at ${String(FIXED_NOW)}_`)).toBe(true);
  });

  it('without a writer it only appends — the State line is left alone', async () => {
    await fs.writeFile(join(String(tmp.root), 'progress.md'), JOURNAL, 'utf8');
    const out = await run('review', false);
    expect(out).toContain('- State: active\n');
    expect(out).toContain('_Sprint transitioned to review at');
  });

  it('a missing journal falls back to appending the separator', async () => {
    const out = await run('review', true);
    expect(out).toContain('_Sprint transitioned to review at');
  });
});
