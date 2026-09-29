import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from '../src/format-bytes.mjs';

test('kilobytes are decimal', () => {
  assert.equal(formatBytes(1500), '1.5 KB');
});
test('megabytes are decimal', () => {
  assert.equal(formatBytes(1000000), '1 MB');
  assert.equal(formatBytes(2500000), '2.5 MB');
});
test('gigabytes are decimal', () => {
  assert.equal(formatBytes(3000000000), '3 GB');
});
