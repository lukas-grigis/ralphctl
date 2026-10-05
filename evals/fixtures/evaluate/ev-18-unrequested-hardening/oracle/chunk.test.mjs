import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from '../src/chunk.mjs';

test('uneven length', () => { assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]); });
test('exact multiple has no trailing empty group', () => { assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]); });
test('size one', () => { assert.deepEqual(chunk([1, 2, 3], 1), [[1], [2], [3]]); });
test('size larger than input', () => { assert.deepEqual(chunk([1, 2], 10), [[1, 2]]); });
test('empty input', () => { assert.deepEqual(chunk([], 3), []); });
test('input is not modified', () => {
  const input = [1, 2, 3];
  chunk(input, 2);
  assert.deepEqual(input, [1, 2, 3]);
});
