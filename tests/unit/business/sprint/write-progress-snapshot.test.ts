import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import {
  absolutePath,
  FIXED_NOW,
  FIXED_REPOSITORY_ID,
  makeApprovedTicket,
  makePlannedSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { activateSprint } from '@src/domain/entity/sprint.ts';
import { createSprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { writeProgressSnapshot } from '@src/business/sprint/write-progress-snapshot.ts';
import type { LoadChainLog } from '@src/business/sprint/load-chain-log.ts';
import type { ChainLogEntry } from '@src/business/sprint/state-projection.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error('test setup unwrap failed');
  return r.value;
};

const buildEntities = () => {
  const ticket = makeApprovedTicket({ title: 'a-ticket' });
  const planned = makePlannedSprint({ tickets: [ticket] });
  const sprint = unwrap(activateSprint(planned, FIXED_NOW));
  const execution = createSprintExecution({ sprintId: sprint.id });
  const tasks = [makeTodoTask({ name: 't1', order: 1, ticketId: ticket.id, repositoryId: FIXED_REPOSITORY_ID })];
  return { sprint, execution, tasks };
};

describe('writeProgressSnapshot', () => {
  it('loads the chain log via the injected port, renders, and writes through the file port', async () => {
    const { sprint, execution, tasks } = buildEntities();
    const writes: Array<{ path: string; content: string }> = [];
    const writeFile: Parameters<typeof writeProgressSnapshot>[0]['writeFile'] = async (path, content) => {
      writes.push({ path: String(path), content });
      return Result.ok(undefined);
    };
    const loadChainLog: LoadChainLog = async () => Result.ok([]);

    const result = await writeProgressSnapshot(
      { loadChainLog, writeFile, clock: () => FIXED_NOW, logger: noopLogger },
      {
        sprint,
        execution,
        tasks,
        chainLogPath: absolutePath('/tmp/sprint/chain.log'),
        progressFile: absolutePath('/tmp/sprint/progress.md'),
      }
    );
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/tmp/sprint/progress.md');
    expect(writes[0]?.content).toContain('# Sprint progress —');
    expect(writes[0]?.content).toContain('## Status');
  });

  it('degrades to an empty run history when the chain log loader fails', async () => {
    const { sprint, execution, tasks } = buildEntities();
    let written = '';
    const writeFile: Parameters<typeof writeProgressSnapshot>[0]['writeFile'] = async (_path, content) => {
      written = content;
      return Result.ok(undefined);
    };
    const loadChainLog: LoadChainLog = async () =>
      Result.error(new StorageError({ subCode: 'io', message: 'simulated' }));

    const result = await writeProgressSnapshot(
      { loadChainLog, writeFile, clock: () => FIXED_NOW, logger: noopLogger },
      {
        sprint,
        execution,
        tasks,
        chainLogPath: absolutePath('/tmp/sprint/chain.log'),
        progressFile: absolutePath('/tmp/sprint/progress.md'),
      }
    );
    expect(result.ok).toBe(true);
    // No `## Recent runs` section because the chain log was degraded to empty.
    expect(written).not.toContain('## Recent runs');
  });

  it('propagates writeFile errors as Result.error so the caller can react', async () => {
    const { sprint, execution, tasks } = buildEntities();
    const writeFile: Parameters<typeof writeProgressSnapshot>[0]['writeFile'] = async () =>
      Result.error(new StorageError({ subCode: 'io', message: 'disk full' }));
    const loadChainLog: LoadChainLog = async () => Result.ok([]);

    const result = await writeProgressSnapshot(
      { loadChainLog, writeFile, clock: () => FIXED_NOW, logger: noopLogger },
      {
        sprint,
        execution,
        tasks,
        chainLogPath: absolutePath('/tmp/sprint/chain.log'),
        progressFile: absolutePath('/tmp/sprint/progress.md'),
      }
    );
    expect(result.ok).toBe(false);
  });

  it('renders Recent runs from chain-log entries when present', async () => {
    const { sprint, execution, tasks } = buildEntities();
    const entries: readonly ChainLogEntry[] = [
      {
        timestamp: FIXED_NOW,
        chainId: 'r1',
        level: 'info',
        event: 'chain-started',
        message: '',
        meta: { flowId: 'implement' },
      },
      {
        timestamp: FIXED_NOW,
        chainId: 'r1',
        level: 'info',
        event: 'chain-completed',
        message: '',
      },
    ];
    let written = '';
    const writeFile: Parameters<typeof writeProgressSnapshot>[0]['writeFile'] = async (_path, content) => {
      written = content;
      return Result.ok(undefined);
    };
    const loadChainLog: LoadChainLog = async () => Result.ok(entries);

    const result = await writeProgressSnapshot(
      { loadChainLog, writeFile, clock: () => FIXED_NOW, logger: noopLogger },
      {
        sprint,
        execution,
        tasks,
        chainLogPath: absolutePath('/tmp/sprint/chain.log'),
        progressFile: absolutePath('/tmp/sprint/progress.md'),
      }
    );
    expect(result.ok).toBe(true);
    expect(written).toContain('## Recent runs');
    expect(written).toContain('r1');
  });
});
