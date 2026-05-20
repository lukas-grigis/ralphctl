import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realpath } from 'node:fs/promises';
import { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import {
  absolutePath,
  FIXED_NOW,
  FIXED_REPOSITORY_ID,
  makeApprovedTicket,
  makePlannedSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { createSprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { activateSprint } from '@src/domain/entity/sprint.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { ensureProgressFileLeaf } from '@src/application/flows/implement/leaves/ensure-progress-file.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createFsChainLogLoader } from '@src/integration/persistence/sprint/load-chain-log.ts';
import { createFsDecisionsLogLoader } from '@src/integration/persistence/sprint/load-decisions-log.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error('test setup unwrap failed');
  return r.value;
};

describe('ensureProgressFileLeaf', () => {
  let dir: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-progress-'));
    dir = await realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const buildCtx = (): ImplementCtx => {
    const ticket = makeApprovedTicket({ title: 't' });
    const planned = makePlannedSprint({ tickets: [ticket] });
    const sprint = unwrap(activateSprint(planned, FIXED_NOW));
    const execution = createSprintExecution({ sprintId: sprint.id });
    const tasks = [makeTodoTask({ name: 'task-1', order: 1, ticketId: ticket.id, repositoryId: FIXED_REPOSITORY_ID })];
    return { sprintId: sprint.id, sprint, execution, tasks };
  };

  it('renders the initial snapshot of progress.md from the activated sprint state and writes ctx.progressFile', async () => {
    const progressPath = absolutePath(join(dir, 'progress.md'));
    const chainLogPath = absolutePath(join(dir, 'chain.log'));
    const decisionsLogPath = absolutePath(join(dir, 'decisions.log'));
    const leafEl = ensureProgressFileLeaf(
      {
        loadChainLog: createFsChainLogLoader(),
        loadDecisionsLog: createFsDecisionsLogLoader(),
        writeFile: createAtomicWriteFile(),
        clock: () => FIXED_NOW,
        logger: noopLogger,
      },
      progressPath,
      chainLogPath,
      decisionsLogPath
    );

    const ctx = buildCtx();
    const result = await leafEl.execute(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx.progressFile).toBe(progressPath);
    }
    const body = await fs.readFile(String(progressPath), 'utf8');
    // The snapshot renderer writes a Markdown digest, not a streaming-sink template.
    expect(body).toContain('# Sprint progress —');
    expect(body).toContain('## Status');
    expect(body).toContain('## Tasks');
  });

  it('overwrites any pre-existing progress.md content — that IS the migration from the streaming-sink era', async () => {
    const progressPath = absolutePath(join(dir, 'progress.md'));
    const chainLogPath = absolutePath(join(dir, 'chain.log'));
    // Simulate legacy streaming-sink output sitting on disk.
    await fs.writeFile(String(progressPath), '# Sprint progress\n\n## Activity\n\n- old streaming bullet\n');

    const decisionsLogPath = absolutePath(join(dir, 'decisions.log'));
    const leafEl = ensureProgressFileLeaf(
      {
        loadChainLog: createFsChainLogLoader(),
        loadDecisionsLog: createFsDecisionsLogLoader(),
        writeFile: createAtomicWriteFile(),
        clock: () => FIXED_NOW,
        logger: noopLogger,
      },
      progressPath,
      chainLogPath,
      decisionsLogPath
    );

    const result = await leafEl.execute(buildCtx());
    expect(result.ok).toBe(true);
    const body = await fs.readFile(String(progressPath), 'utf8');
    expect(body).not.toContain('old streaming bullet');
    expect(body).toContain('## Status');
  });

  it('returns InvalidStateError when upstream load leaves did not populate ctx', async () => {
    const progressPath = absolutePath(join(dir, 'progress.md'));
    const chainLogPath = absolutePath(join(dir, 'chain.log'));
    const decisionsLogPath = absolutePath(join(dir, 'decisions.log'));
    const leafEl = ensureProgressFileLeaf(
      {
        loadChainLog: createFsChainLogLoader(),
        loadDecisionsLog: createFsDecisionsLogLoader(),
        writeFile: createAtomicWriteFile(),
        clock: () => FIXED_NOW,
        logger: noopLogger,
      },
      progressPath,
      chainLogPath,
      decisionsLogPath
    );
    const result = await leafEl.execute({ sprintId: 'sprint-x' as SprintId } satisfies ImplementCtx);
    expect(result.ok).toBe(false);
  });

  it('renders progress.md from the partial chain.log when present (tolerant parser)', async () => {
    const progressPath = absolutePath(join(dir, 'progress.md'));
    const chainLogPath = absolutePath(join(dir, 'chain.log'));
    // Mix of boundary lines, blank lines, valid events, and a malformed line.
    await fs.writeFile(
      String(chainLogPath),
      [
        '=== chain-run r1 implement started 2026-05-08T10:00:00.000Z ===',
        JSON.stringify({ type: 'chain-started', chainId: 'r1', flowId: 'implement', at: '2026-05-08T10:00:00.000Z' }),
        '',
        '{ this is not valid json',
        JSON.stringify({ type: 'chain-completed', chainId: 'r1', at: '2026-05-08T10:05:00.000Z' }),
        '=== chain-run r1 implement completed 2026-05-08T10:05:00.000Z duration=300000ms steps=2 ===',
        '',
      ].join('\n')
    );

    const decisionsLogPath = absolutePath(join(dir, 'decisions.log'));
    const leafEl = ensureProgressFileLeaf(
      {
        loadChainLog: createFsChainLogLoader(),
        loadDecisionsLog: createFsDecisionsLogLoader(),
        writeFile: createAtomicWriteFile(),
        clock: () => FIXED_NOW,
        logger: noopLogger,
      },
      progressPath,
      chainLogPath,
      decisionsLogPath
    );

    const result = await leafEl.execute(buildCtx());
    expect(result.ok).toBe(true);
    const body = await fs.readFile(String(progressPath), 'utf8');
    expect(body).toContain('## Recent runs');
    expect(body).toContain('r1');
    // Just to confirm we used the loadChainLog adapter, not a stub:
    void Result;
  });
});
