import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/index.mjs';

test('slugify through the public entry point', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  A  b '), 'a-b');
});
