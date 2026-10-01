import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { LiveRunRecord, LiveRunStore } from '@src/business/runs/live-run.ts';
import { isNodeErrnoCode, listDir, writeJsonAtomic } from '@src/integration/io/fs.ts';

/** `<stateRoot>/runs` — distinct from `<dataRoot>/runs`, which holds one-shot flows' forensic artifacts. */
export const liveRunsDir = (stateRoot: AbsolutePath): string => join(String(stateRoot), 'runs');

const identitySchema = z.object({ startedAt: z.string(), command: z.string() });

const spawnSchema = z.object({
  pid: z.number().int().positive(),
  pgid: z.number().int().positive().optional(),
  provider: z.string(),
  command: z.string(),
  cwd: z.string(),
  role: z.enum(['generator', 'evaluator']).optional(),
  round: z.number().int().nonnegative().optional(),
  signalsFile: z.string(),
  sessionId: z.string().optional(),
  identity: identitySchema.optional(),
  startedAt: z.string(),
  exitedAt: z.string().optional(),
});

// Not `.strict()`: a newer ralphctl may add fields, and an older reader must still see the run.
const recordSchema = z.object({
  version: z.number().int().positive(),
  runId: z.string().min(1),
  flowId: z.string(),
  projectId: z.string().optional(),
  sprintId: z.string().optional(),
  owner: z.object({
    pid: z.number().int().positive(),
    host: z.string(),
    machineId: z.string().optional(),
    startedAt: z.string(),
    identity: identitySchema.optional(),
  }),
  startedAt: z.string(),
  updatedAt: z.string(),
  spawns: z.array(spawnSchema),
  reapedAt: z.string().optional(),
});

/** A run id becomes a file name; anything that could escape the directory is refused. */
const safeFileName = (runId: string): string | undefined =>
  /^[\w.-]+$/.test(runId) && runId !== '.' && runId !== '..' ? `${runId}.json` : undefined;

const parseRecord = (raw: string): LiveRunRecord | undefined => {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as LiveRunRecord) : undefined;
  } catch {
    return undefined;
  }
};

const badRunId = (runId: string): StorageError =>
  new StorageError({ subCode: 'io', message: `invalid run id for a live-run record: ${runId}` });

export const createFsLiveRunStore = (opts: { readonly stateRoot: AbsolutePath }): LiveRunStore => {
  const dir = liveRunsDir(opts.stateRoot);
  return {
    async list() {
      const names = await listDir(dir);
      if (!names.ok) return Result.error(names.error);
      const records: LiveRunRecord[] = [];
      for (const name of names.value) {
        if (!name.endsWith('.json')) continue;
        let raw: string;
        try {
          raw = await fs.readFile(join(dir, name), 'utf8');
        } catch {
          continue; // removed between listing and reading — the run settled
        }
        const record = parseRecord(raw);
        if (record !== undefined) records.push(record);
      }
      return Result.ok(records) as Result<readonly LiveRunRecord[], StorageError>;
    },
    async save(record) {
      const file = safeFileName(record.runId);
      if (file === undefined) return Result.error(badRunId(record.runId));
      return writeJsonAtomic(join(dir, file), record);
    },
    async remove(runId) {
      const file = safeFileName(runId);
      if (file === undefined) return Result.error(badRunId(runId));
      try {
        await fs.unlink(join(dir, file));
      } catch (cause) {
        if (!isNodeErrnoCode(cause, 'ENOENT')) {
          return Result.error(
            new StorageError({ subCode: 'io', message: `could not remove live-run record ${runId}`, cause })
          );
        }
      }
      return Result.ok(undefined) as Result<void, StorageError>;
    },
  };
};
