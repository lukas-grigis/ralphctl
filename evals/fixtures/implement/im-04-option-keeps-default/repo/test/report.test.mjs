import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeLine } from '../src/report.mjs';

test('report uses binary units', () => {
  assert.equal(sizeLine('a.bin', 2048), 'a.bin: 2 KB');
});
