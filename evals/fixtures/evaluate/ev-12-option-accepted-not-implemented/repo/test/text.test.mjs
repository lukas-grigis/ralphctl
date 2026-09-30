import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordCount } from '../src/index.mjs';

test('counts words', () => {
  assert.equal(wordCount('a b  c'), 3);
});
