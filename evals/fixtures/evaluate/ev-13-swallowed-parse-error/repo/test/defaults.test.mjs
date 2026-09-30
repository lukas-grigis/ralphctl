import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/defaults.mjs';

test('defaults retry three times', () => {
  assert.equal(DEFAULTS.retries, 3);
});
