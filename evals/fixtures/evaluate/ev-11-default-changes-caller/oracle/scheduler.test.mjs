import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDelay } from '../src/scheduler.mjs';

test('the scheduler delay is deterministic', () => {
  assert.equal(nextDelay(3), 800);
  assert.equal(nextDelay(0), 100);
});
