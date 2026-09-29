import { test } from 'node:test';
import assert from 'node:assert/strict';
import { range } from '../src/range.mjs';

test('end value is included', () => {
  assert.deepEqual(range(1, 3), [1, 2, 3]);
});
test('single element interval', () => {
  assert.deepEqual(range(2, 2), [2]);
});
test('start past end is empty', () => {
  assert.deepEqual(range(5, 2), []);
});
