import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.mjs';

test('page zero is rejected', () => {
  assert.throws(() => paginate([1, 2, 3], 0, 2), RangeError);
});
test('page one is the first page', () => {
  assert.deepEqual(paginate([1, 2, 3], 1, 2).items, [1, 2]);
});
test('pageSize zero is rejected', () => {
  assert.throws(() => paginate([1, 2, 3], 1, 0), RangeError);
});
