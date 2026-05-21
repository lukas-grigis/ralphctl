import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createFsChainLogLoader } from '@src/integration/persistence/sprint/load-chain-log.ts';

describe('createFsChainLogLoader', () => {
  let dir: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-chainlog-'));
    dir = await realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns an empty list when chain.log does not exist (tolerant)', async () => {
    const load = createFsChainLogLoader();
    const result = await load(absolutePath(join(dir, 'chain.log')));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('skips boundary lines, blank lines, and malformed JSON; returns the rest', async () => {
    const path = join(dir, 'chain.log');
    await fs.writeFile(
      path,
      [
        '=== chain-run r1 implement started 2026-05-08T10:00:00.000Z ===',
        '',
        JSON.stringify({ type: 'chain-started', chainId: 'r1', flowId: 'implement', at: '2026-05-08T10:00:00.000Z' }),
        '{ malformed line',
        JSON.stringify({
          type: 'chain-step-completed',
          chainId: 'r1',
          elementName: 'ensure-progress-file',
          durationMs: 5,
          at: '2026-05-08T10:00:01.000Z',
        }),
        JSON.stringify({ type: 'chain-completed', chainId: 'r1', at: '2026-05-08T10:00:05.000Z' }),
        '=== chain-run r1 implement completed 2026-05-08T10:00:05.000Z duration=5000ms steps=1 ===',
        '',
      ].join('\n')
    );

    const load = createFsChainLogLoader();
    const result = await load(absolutePath(path));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events = result.value.map((e) => e.event);
    expect(events).toEqual(['chain-started', 'chain-step-completed', 'chain-completed']);
  });

  it('parses NDJSON-tail with no trailing newline', async () => {
    const path = join(dir, 'chain.log');
    await fs.writeFile(
      path,
      JSON.stringify({ type: 'chain-started', chainId: 'r1', flowId: 'implement', at: '2026-05-08T10:00:00.000Z' })
    );
    const load = createFsChainLogLoader();
    const result = await load(absolutePath(path));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(1);
  });

  it('caps the read at the tail bytes and drops the leading partial line on truncation', async () => {
    const path = join(dir, 'chain.log');
    // Fill the file with junk past the 8 MiB cap, then append a known sequence so a tail-read
    // recovers the recent events while discarding the (now-mid-line) leading garbage.
    const junk = `${'x'.repeat(1024 * 1024 - 1)}\n`; // 1 MiB minus newline + newline
    await fs.writeFile(path, junk.repeat(9));
    await fs.appendFile(
      path,
      [
        JSON.stringify({ type: 'chain-started', chainId: 'rN', flowId: 'implement', at: '2026-05-08T10:00:00.000Z' }),
        JSON.stringify({ type: 'chain-completed', chainId: 'rN', at: '2026-05-08T10:00:05.000Z' }),
        '',
      ].join('\n')
    );
    const load = createFsChainLogLoader();
    const result = await load(absolutePath(path));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The most-recent two structured events MUST come through; whatever leading partial line the
    // 8 MiB window cut into is discarded.
    const events = result.value.map((e) => e.event);
    expect(events.slice(-2)).toEqual(['chain-started', 'chain-completed']);
  });
});
