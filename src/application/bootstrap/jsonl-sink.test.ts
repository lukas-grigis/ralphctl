import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { JsonlFileWriter } from '../../integration/logging/jsonl-file-writer.ts';
import { JsonlSink } from './jsonl-sink.ts';

function uniqueLogsDir(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-jsonl-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

async function flushAndDispose(writer: JsonlFileWriter): Promise<void> {
  await writer.dispose();
}

describe('JsonlSink', () => {
  let logsDir: AbsolutePath;

  beforeEach(() => {
    logsDir = uniqueLogsDir();
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  it('writes a JSONL line per emission at level error (under VITEST=1)', async () => {
    const writer = new JsonlFileWriter({ sessionId: 'unit', logsDir });
    const sink = new JsonlSink(writer);
    // Under vitest the default level is `error`, so info/warn/debug drop.
    sink.error('explosion', { taskId: 'tid' });
    await flushAndDispose(writer);
    const file = join(logsDir, 'unit.jsonl');
    const body = await readFile(file, 'utf-8');
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(record['level']).toBe('error');
    expect(record['message']).toBe('explosion');
    expect(record['taskId']).toBe('tid');
  });

  it('child propagates bound context into records', async () => {
    const writer = new JsonlFileWriter({ sessionId: 'unit2', logsDir });
    const sink = new JsonlSink(writer).child({ scope: 'wrap' });
    sink.error('hi');
    await flushAndDispose(writer);
    const file = join(logsDir, 'unit2.jsonl');
    const body = await readFile(file, 'utf-8');
    const record = JSON.parse(body.trim()) as Record<string, unknown>;
    expect(record['scope']).toBe('wrap');
  });

  it('respects an explicit level option', async () => {
    const writer = new JsonlFileWriter({ sessionId: 'unit3', logsDir });
    const sink = new JsonlSink(writer, { level: 'debug' });
    sink.info('seen');
    sink.debug('also seen');
    await flushAndDispose(writer);
    const body = await readFile(join(logsDir, 'unit3.jsonl'), 'utf-8');
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});
