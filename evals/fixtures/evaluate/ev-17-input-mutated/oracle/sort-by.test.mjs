import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortBy } from '../src/sort-by.mjs';

test('input is not modified', () => {
  const input = [3, 1, 2];
  const out = sortBy(input, (x) => x);
  assert.deepEqual(input, [3, 1, 2]);
  assert.deepEqual(out, [1, 2, 3]);
  assert.notEqual(out, input);
});
test('stable for equal keys', () => {
  const out = sortBy([{ k: 1, id: 'a' }, { k: 0, id: 'b' }, { k: 1, id: 'c' }], (x) => x.k);
  assert.deepEqual(out.map((x) => x.id), ['b', 'a', 'c']);
});
