import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/duration.mjs';

test('hours are 3600 seconds', () => {
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('1h30m15s'), 5415);
});
test('minutes and seconds', () => {
  assert.equal(parseDuration('5m'), 300);
  assert.equal(parseDuration('90s'), 90);
});
test('malformed input throws', () => {
  assert.throws(() => parseDuration(''), TypeError);
  assert.throws(() => parseDuration('5x'), TypeError);
});
