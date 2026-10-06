import { test } from 'node:test';
import assert from 'node:assert/strict';
import { first } from '../src/arrays.mjs';

test('first returns the head', () => {
  assert.equal(first([1, 2]), 1);
});
