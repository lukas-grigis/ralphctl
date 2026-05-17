import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { readSignalsFile } from '@src/integration/ai/signals/_engine/read-signals-file.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

describe('readSignalsFile', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const path = (name: string): AbsolutePath => {
    const r = AbsolutePath.parse(join(String(root.root), name));
    if (!r.ok) throw new Error('test setup: bad path');
    return r.value;
  };

  it('returns the parsed signal array on a well-formed file', async () => {
    const p = path('ok.json');
    await fs.writeFile(
      String(p),
      JSON.stringify([
        { type: 'note', text: 'a', timestamp: '2026-05-09T10:00:00.000Z' },
        { type: 'task-blocked', reason: 'b', timestamp: '2026-05-09T10:00:00.000Z' },
      ]),
      'utf8'
    );
    const result = await readSignalsFile(p);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((s) => s.type)).toEqual(['note', 'task-blocked']);
  });

  it('returns an empty array for `[]` (canonical "no signals" payload from the provider)', async () => {
    const p = path('empty.json');
    await fs.writeFile(String(p), '[]', 'utf8');
    const result = await readSignalsFile(p);
    expect(result.ok && result.value).toEqual([]);
  });

  it('returns an empty array when the JSON is well-formed but not an array (defensive)', async () => {
    // A misbehaving provider could write `{}` or `null`. We don't crash; we treat it as "no signals."
    const p = path('non-array.json');
    await fs.writeFile(String(p), '{"oops": true}', 'utf8');
    const result = await readSignalsFile(p);
    expect(result.ok && result.value).toEqual([]);
  });

  it('surfaces NotFoundError when the file is missing', async () => {
    const result = await readSignalsFile(path('missing.json'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NotFound);
  });

  it('surfaces StorageError(parse) on malformed JSON', async () => {
    const p = path('garbage.json');
    await fs.writeFile(String(p), 'not json at all', 'utf8');
    const result = await readSignalsFile(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.Storage);
      // subCode is 'parse' for JSON.parse failure, 'io' for read failure.
      expect((result.error as { subCode: string }).subCode).toBe('parse');
    }
  });
});
