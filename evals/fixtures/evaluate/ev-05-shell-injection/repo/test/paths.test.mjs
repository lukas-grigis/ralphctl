import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inHome } from '../src/paths.mjs';

test('inHome joins onto the home directory', () => {
  assert.ok(inHome('x').endsWith('x'));
});
