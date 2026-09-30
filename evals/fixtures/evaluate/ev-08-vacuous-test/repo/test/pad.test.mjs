import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pad2 } from '../src/pad.mjs';

test('pads single digits', () => {
  assert.equal(pad2(7), '07');
});
