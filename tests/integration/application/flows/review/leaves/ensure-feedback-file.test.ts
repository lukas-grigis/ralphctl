import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ensureFeedbackFileLeaf } from '@src/application/flows/review/leaves/ensure-feedback-file.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { makeDraftSprint } from '@tests/fixtures/domain.ts';

/**
 * Integration tests for `ensureFeedbackFileLeaf`.
 *
 * The leaf materialises `feedback.md` at a given path if the file is absent, threads the
 * path forward on `ctx.feedbackFile`, and is idempotent (a pre-existing file is left
 * untouched). These tests exercise the I/O contract against a real tmpdir.
 */

const makeCtx = (): ReviewCtx => ({
  sprintId: makeDraftSprint().id,
  distillRequested: false,
});

const parsePath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`invalid path: ${p}`);
  return r.value;
};

describe('ensureFeedbackFileLeaf', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const feedbackPath = (): string => join(String(root.root), 'feedback.md');

  it('creates file with template when absent', async () => {
    const feedbackFile = parsePath(feedbackPath());
    const leaf = ensureFeedbackFileLeaf(feedbackFile);

    const result = await leaf.execute(makeCtx());

    expect(result.ok).toBe(true);
    const content = await fs.readFile(feedbackPath(), 'utf8');
    expect(content).toContain('# Feedback');
    expect(content).toContain('Round 1');
    // The template includes the marker comment the round parser relies on.
    expect(content).toContain('write your feedback below');
  });

  it('reuses existing file without overwriting its content', async () => {
    const existingContent = '# My custom feedback\n\n- existing round instructions\n';
    await fs.writeFile(feedbackPath(), existingContent, 'utf8');

    const feedbackFile = parsePath(feedbackPath());
    const leaf = ensureFeedbackFileLeaf(feedbackFile);

    const result = await leaf.execute(makeCtx());

    expect(result.ok).toBe(true);
    const content = await fs.readFile(feedbackPath(), 'utf8');
    expect(content).toBe(existingContent);
  });

  it('threads feedbackFile path onto ctx', async () => {
    const feedbackFile = parsePath(feedbackPath());
    const leaf = ensureFeedbackFileLeaf(feedbackFile);
    const ctx = makeCtx();

    const result = await leaf.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.feedbackFile).toBeDefined();
    expect(String(result.value.ctx.feedbackFile)).toBe(feedbackPath());
  });

  it('is idempotent — second run succeeds and leaves file unchanged', async () => {
    const feedbackFile = parsePath(feedbackPath());
    const leaf = ensureFeedbackFileLeaf(feedbackFile);

    await leaf.execute(makeCtx());
    const contentAfterFirst = await fs.readFile(feedbackPath(), 'utf8');

    const result2 = await leaf.execute(makeCtx());
    expect(result2.ok).toBe(true);
    const contentAfterSecond = await fs.readFile(feedbackPath(), 'utf8');

    expect(contentAfterFirst).toBe(contentAfterSecond);
  });
});
