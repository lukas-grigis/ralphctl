import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAsync } from '../src/map-async.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('results follow input order, not completion order', async () => {
  const out = await mapAsync([30, 5, 15], async (ms, i) => { await sleep(ms); return i; });
  assert.deepEqual(out, [0, 1, 2]);
});
test('rejects with the first error', async () => {
  await assert.rejects(mapAsync([1, 2], async (x) => { if (x === 2) throw new Error('boom'); return x; }), /boom/);
});
