import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capDelay } from '../src/limits.mjs';

test('capDelay caps at the maximum', () => {
  assert.equal(capDelay(50000), 30000);
  assert.equal(capDelay(10), 10);
});
