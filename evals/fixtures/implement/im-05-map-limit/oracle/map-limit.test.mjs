import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../src/map-limit.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('never exceeds the limit and keeps order', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([0, 1, 2, 3, 4, 5], 2, async (x) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(x % 2 === 0 ? 15 : 5);
    inFlight -= 1;
    return x;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
});
test('a rejection stops new work', async () => {
  const started = [];
  await assert.rejects(mapLimit([0, 1, 2, 3, 4], 2, async (x) => {
    started.push(x);
    if (x === 0) { await sleep(5); throw new Error('boom'); }
    await sleep(20);
    return x;
  }), /boom/);
  await sleep(80);
  assert.deepEqual(started, [0, 1]);
});
test('empty input', async () => {
  assert.deepEqual(await mapLimit([], 3, async (x) => x), []);
});
test('invalid limit', async () => {
  await assert.rejects(async () => mapLimit([1], 0, async (x) => x), RangeError);
});
