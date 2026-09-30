import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordCount } from '../src/index.mjs';

test('wordCount counts words', () => {
  assert.equal(wordCount('a b  c'), 3);
});
