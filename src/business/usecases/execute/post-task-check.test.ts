import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { FakeExternalPort } from '../../_test-fakes/fake-external-port.ts';
import { FakeLoggerPort } from '../../_test-fakes/fake-logger-port.ts';
import { PostTaskCheckUseCase } from './post-task-check.ts';

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('PostTaskCheckUseCase', () => {
  it('runs the check script and reports passed', async () => {
    const external = new FakeExternalPort({
      checkScriptOutcomes: [{ passed: true, output: 'all green' }],
    });
    const uc = new PostTaskCheckUseCase(external, new FakeLoggerPort());

    const result = await uc.execute({
      projectPath: path('/repos/demo'),
      checkScript: 'pnpm test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.passed).toBe(true);
    expect(result.value.skipped).toBe(false);
    expect(external.checkScriptCalls).toHaveLength(1);
    expect(external.checkScriptCalls[0]?.phase).toBe('post-task');
  });

  it('reports failed when the check script fails', async () => {
    const external = new FakeExternalPort({
      checkScriptOutcomes: [{ passed: false, output: '3 tests failing' }],
    });
    const logger = new FakeLoggerPort();
    const uc = new PostTaskCheckUseCase(external, logger);

    const result = await uc.execute({
      projectPath: path('/repos/demo'),
      checkScript: 'pnpm test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.passed).toBe(false);
    expect(result.value.output).toBe('3 tests failing');
    expect(logger.hasMessage('warn', 'post-task check failed')).toBe(true);
  });

  it('skips the check when changedFilesSinceBaseline is empty', async () => {
    const external = new FakeExternalPort();
    const uc = new PostTaskCheckUseCase(external, new FakeLoggerPort());

    const result = await uc.execute({
      projectPath: path('/repos/demo'),
      checkScript: 'pnpm test',
      changedFilesSinceBaseline: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped).toBe(true);
    expect(result.value.passed).toBe(true);
    expect(external.checkScriptCalls).toHaveLength(0);
  });

  it('runs the check when changedFilesSinceBaseline has entries', async () => {
    const external = new FakeExternalPort({
      checkScriptOutcomes: [{ passed: true, output: '' }],
    });
    const uc = new PostTaskCheckUseCase(external, new FakeLoggerPort());

    const result = await uc.execute({
      projectPath: path('/repos/demo'),
      checkScript: 'pnpm test',
      changedFilesSinceBaseline: ['src/foo.ts'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped).toBe(false);
    expect(external.checkScriptCalls).toHaveLength(1);
  });

  it('forwards timeoutMs to the external port', async () => {
    const external = new FakeExternalPort({
      checkScriptOutcomes: [{ passed: true, output: '' }],
    });
    const uc = new PostTaskCheckUseCase(external, new FakeLoggerPort());

    await uc.execute({
      projectPath: path('/repos/demo'),
      checkScript: 'pnpm test',
      timeoutMs: 60_000,
    });

    expect(external.checkScriptCalls[0]?.timeout).toBe(60_000);
  });

  it('logs an info line with the script name', async () => {
    const logger = new FakeLoggerPort();
    const external = new FakeExternalPort({
      checkScriptOutcomes: [{ passed: true, output: '' }],
    });
    const uc = new PostTaskCheckUseCase(external, logger);

    await uc.execute({
      projectPath: path('/repos/demo'),
      checkScript: 'pnpm test',
    });

    expect(logger.hasMessage('info', 'running post-task check')).toBe(true);
  });
});
