import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from '../src/format-bytes.mjs';

test('bytes stay bytes', () => {
  assert.equal(formatBytes(512), '512 B');
});

test('kilobytes', () => {
  assert.equal(formatBytes(2048), '2 KB');
});

test('megabytes', () => {
  assert.equal(formatBytes(1048576), '1 MB');
});
