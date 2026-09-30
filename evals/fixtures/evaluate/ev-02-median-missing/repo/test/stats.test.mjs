import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from '../src/stats.mjs';

test('sum adds numbers', () => {
  assert.equal(sum([1, 2, 3]), 6);
});

test('sum of nothing is zero', () => {
  assert.equal(sum([]), 0);
});
