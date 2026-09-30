import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from '../src/format-bytes.mjs';
import { sizeLine } from '../src/report.mjs';

test('default stays binary', () => {
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1048576), '1 MB');
  assert.equal(sizeLine('x', 1048576), 'x: 1 MB');
});
test('explicit binary matches the default', () => {
  assert.equal(formatBytes(1536, { base: 1024 }), '1.5 KB');
});
test('SI on request', () => {
  assert.equal(formatBytes(1500, { base: 1000 }), '1.5 KB');
  assert.equal(formatBytes(1000000, { base: 1000 }), '1 MB');
  assert.equal(formatBytes(2500000000, { base: 1000 }), '2.5 GB');
});
