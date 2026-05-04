import { describe, expect, it, vi } from 'vitest';

import { FakeWriteContextFilePort } from '@src/business/_test-fakes/fake-write-context-file-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { sprintId } from '@src/application/_test-fakes/fixtures.ts';
import { renderPromptToFileLeaf, type CtxWithPromptFilePath } from './render-prompt-to-file.ts';

/** Minimal context shape that satisfies CtxWithPromptFilePath. */
interface TestCtx extends CtxWithPromptFilePath {
  readonly extra?: string;
}

const SPRINT_ID = sprintId('20260429-120000-render-test');
const FLOW = 'execute';
const IDENTIFIER = 'task-abc';

function makeCtx(overrides: Partial<TestCtx> = {}): TestCtx {
  return { sprintId: SPRINT_ID, ...overrides };
}

describe('renderPromptToFileLeaf', () => {
  it('writes the rendered prompt under <sprintDir>/contexts/<flow>-<identifier>.md and stamps promptFilePath on ctx', async () => {
    const fakePort = new FakeWriteContextFilePort();
    const buildPrompt = vi.fn().mockResolvedValue(Result.ok('hello world'));

    const leaf = renderPromptToFileLeaf<TestCtx>(
      { writeContextFile: fakePort },
      {
        flowName: FLOW,
        identifier: () => IDENTIFIER,
        buildPrompt,
      }
    );

    const result = await leaf.execute(makeCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The file was written exactly once.
    expect(fakePort.writes).toHaveLength(1);
    const write = fakePort.writes[0];
    expect(write?.content).toBe('hello world');

    // Path contains the expected segments.
    const pathStr = String(write?.path);
    expect(pathStr).toContain(`contexts/${FLOW}-${IDENTIFIER}.md`);

    // promptFilePath is stamped on the context.
    expect(String(result.value.ctx.promptFilePath)).toBe(pathStr);

    // Trace records the step.
    expect(result.value.trace[0]?.stepName).toBe('render-prompt-to-file');
    expect(result.value.trace[0]?.status).toBe('completed');
  });

  it('taskBlocked === true: short-circuits — no buildPrompt call, no write, returns ok with the resolved path', async () => {
    const fakePort = new FakeWriteContextFilePort();
    let buildPromptCallCount = 0;
    const buildPrompt = (): Promise<Result<string, StorageError>> => {
      buildPromptCallCount++;
      return Promise.resolve(Result.ok('should not be called'));
    };

    const leaf = renderPromptToFileLeaf<TestCtx>(
      { writeContextFile: fakePort },
      {
        flowName: FLOW,
        identifier: () => IDENTIFIER,
        buildPrompt,
      }
    );

    const result = await leaf.execute(makeCtx({ taskBlocked: true }));

    expect(result.ok).toBe(true);
    expect(buildPromptCallCount).toBe(0);
    expect(fakePort.writes).toHaveLength(0);

    // The resolved path is still stamped on ctx (dummy path).
    if (!result.ok) return;
    expect(result.value.ctx.promptFilePath).toBeDefined();
  });

  it('opts.skip returns true: short-circuits — no buildPrompt call, no write', async () => {
    const fakePort = new FakeWriteContextFilePort();
    let buildPromptCallCount = 0;
    const buildPrompt = (): Promise<Result<string, StorageError>> => {
      buildPromptCallCount++;
      return Promise.resolve(Result.ok('should not be called'));
    };

    const leaf = renderPromptToFileLeaf<TestCtx>(
      { writeContextFile: fakePort },
      {
        flowName: FLOW,
        identifier: () => IDENTIFIER,
        buildPrompt,
        skip: () => true,
      }
    );

    const result = await leaf.execute(makeCtx());

    expect(result.ok).toBe(true);
    expect(buildPromptCallCount).toBe(0);
    expect(fakePort.writes).toHaveLength(0);
  });

  it('buildPrompt returns Result.error → leaf step fails with the same StorageError; no write fired', async () => {
    const fakePort = new FakeWriteContextFilePort();
    const buildError = new StorageError({ subCode: 'io', message: 'template not found' });
    const buildPrompt = vi.fn().mockResolvedValue(Result.error(buildError));

    const leaf = renderPromptToFileLeaf<TestCtx>(
      { writeContextFile: fakePort },
      {
        flowName: FLOW,
        identifier: () => IDENTIFIER,
        buildPrompt,
      }
    );

    const result = await leaf.execute(makeCtx());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('storage-error');
    expect(result.error.error.message).toBe('template not found');
    expect(result.error.trace[0]?.status).toBe('failed');
    expect(fakePort.writes).toHaveLength(0);
  });

  it('writeContextFile.write returns Result.error → leaf step fails with the same StorageError', async () => {
    const writeError = new StorageError({ subCode: 'io', message: 'disk full' });
    const fakePort = new FakeWriteContextFilePort({ failWith: writeError });
    const buildPrompt = vi.fn().mockResolvedValue(Result.ok('some content'));

    const leaf = renderPromptToFileLeaf<TestCtx>(
      { writeContextFile: fakePort },
      {
        flowName: FLOW,
        identifier: () => IDENTIFIER,
        buildPrompt,
      }
    );

    const result = await leaf.execute(makeCtx());

    // The write was attempted (buildPrompt ran, write was called).
    expect(fakePort.writes).toHaveLength(1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('storage-error');
    expect(result.error.error.message).toBe('disk full');
    expect(result.error.trace[0]?.status).toBe('failed');
  });
});
