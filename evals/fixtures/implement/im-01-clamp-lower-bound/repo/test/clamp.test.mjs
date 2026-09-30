import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/clamp.mjs';

test('clamps above the upper bound', () => {
  assert.equal(clamp(15, 0, 10), 10);
});

test('clamps below the lower bound', () => {
  assert.equal(clamp(-5, 0, 10), 0);
});

test('leaves in-range values alone', () => {
  assert.equal(clamp(5, 0, 10), 5);
});
