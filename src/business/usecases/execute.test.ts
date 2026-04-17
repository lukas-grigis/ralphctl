/**
 * Focused regression tests for ExecuteTasksUseCase's per-task config read
 * (REQ-12 — live config). Integration behaviour is covered by CLI tests;
 * these tests exercise only the behaviour the requirement introduced.
 */

import { describe, it, expect, vi } from 'vitest';
import { ExecuteTasksUseCase } from './execute.ts';
import type { PersistencePort } from '@src/domain/repositories/persistence.ts';

function makePersistenceWithGetConfig(values: { evaluationIterations?: number }[]) {
  const getConfig = vi.fn();
  for (const v of values) {
    getConfig.mockResolvedValueOnce({ currentSprint: null, aiProvider: null, editor: null, ...v });
  }
  return { persistence: { getConfig } as unknown as PersistencePort, getConfig };
}

interface PrivateHandle {
  getEvaluationConfig: (options?: { noEvaluate?: boolean; session?: boolean }) => Promise<{
    enabled: boolean;
    iterations: number;
  }>;
}

function createUseCase(persistence: PersistencePort): PrivateHandle {
  const placeholder = {} as never;
  const instance = new ExecuteTasksUseCase(
    persistence,
    placeholder,
    placeholder,
    placeholder,
    placeholder,
    placeholder,
    placeholder,
    placeholder,
    placeholder,
    placeholder,
    placeholder
  );
  return instance as unknown as PrivateHandle;
}

describe('ExecuteTasksUseCase — live config (REQ-12)', () => {
  it('reads evaluationIterations fresh on each call (no snapshot)', async () => {
    const { persistence, getConfig } = makePersistenceWithGetConfig([
      { evaluationIterations: 2 },
      { evaluationIterations: 0 },
      { evaluationIterations: 5 },
    ]);
    const uc = createUseCase(persistence);

    const first = await uc.getEvaluationConfig();
    const second = await uc.getEvaluationConfig();
    const third = await uc.getEvaluationConfig();

    expect(getConfig).toHaveBeenCalledTimes(3);
    expect(first).toEqual({ enabled: true, iterations: 2 });
    expect(second).toEqual({ enabled: false, iterations: 0 });
    expect(third).toEqual({ enabled: true, iterations: 5 });
  });

  it('honours --no-evaluate even when iterations > 0', async () => {
    const { persistence } = makePersistenceWithGetConfig([{ evaluationIterations: 3 }]);
    const uc = createUseCase(persistence);
    const cfg = await uc.getEvaluationConfig({ noEvaluate: true });
    expect(cfg).toEqual({ enabled: false, iterations: 3 });
  });

  it('honours session mode (disables evaluation)', async () => {
    const { persistence } = makePersistenceWithGetConfig([{ evaluationIterations: 3 }]);
    const uc = createUseCase(persistence);
    const cfg = await uc.getEvaluationConfig({ session: true });
    expect(cfg).toEqual({ enabled: false, iterations: 3 });
  });

  it('defaults to 1 when evaluationIterations is unset', async () => {
    const { persistence } = makePersistenceWithGetConfig([{}]);
    const uc = createUseCase(persistence);
    const cfg = await uc.getEvaluationConfig();
    expect(cfg).toEqual({ enabled: true, iterations: 1 });
  });
});
