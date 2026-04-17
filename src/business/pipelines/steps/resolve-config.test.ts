import { describe, expect, it, vi } from 'vitest';
import { StorageError } from '@src/domain/errors.ts';
import type { Config } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { StepContext } from '@src/domain/context.ts';
import { resolveConfigStep } from './resolve-config.ts';

interface Ctx extends StepContext {
  config?: Config;
}

function makePersistence(overrides: Partial<PersistencePort>): PersistencePort {
  return { ...({} as PersistencePort), ...overrides };
}

describe('resolveConfigStep', () => {
  it('loads config fresh from persistence', async () => {
    const config: Config = {
      currentSprint: 's1',
      aiProvider: 'claude',
      editor: null,
      evaluationIterations: 2,
    };
    const getConfig = vi.fn(() => Promise.resolve(config));
    const step = resolveConfigStep<Ctx>(makePersistence({ getConfig }));

    const result = await step.execute({ sprintId: 's1' });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ config });
    expect(getConfig).toHaveBeenCalled();
  });

  it('re-reads config on every invocation (no snapshot)', async () => {
    let call = 0;
    const step = resolveConfigStep<Ctx>(
      makePersistence({
        getConfig: () =>
          Promise.resolve({
            currentSprint: null,
            aiProvider: null,
            editor: null,
            evaluationIterations: ++call,
          }),
      })
    );

    const r1 = await step.execute({ sprintId: 's1' });
    const r2 = await step.execute({ sprintId: 's1' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.value?.config?.evaluationIterations).toBe(1);
    expect(r2.value?.config?.evaluationIterations).toBe(2);
  });

  it('wraps unknown errors as StorageError', async () => {
    const step = resolveConfigStep<Ctx>(
      makePersistence({
        getConfig: () => Promise.reject(new Error('corrupt config')),
      })
    );

    const result = await step.execute({ sprintId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StorageError);
  });
});
