import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mean, median } from '../src/stats.mjs';

test('mean', () => {
  assert.equal(mean([1, 2, 6]), 3);
  assert.equal(mean([]), 0);
});
test('median odd and even', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
});
