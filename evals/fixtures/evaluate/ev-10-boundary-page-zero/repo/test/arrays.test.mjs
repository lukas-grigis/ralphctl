import { test } from 'node:test';
import assert from 'node:assert/strict';
import { last } from '../src/arrays.mjs';

test('last returns the final element', () => {
  assert.equal(last([1, 2, 3]), 3);
});
