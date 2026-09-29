import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/index.mjs';

test('slugify', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});
test('truncates', () => {
  assert.equal(slugify('hello world', { maxLength: 5 }), 'hello');
  assert.equal(slugify('aaa bbb', { maxLength: 4 }), 'aaa');
});
test('default limit is 80', () => {
  assert.equal(slugify('a'.repeat(100)).length, 80);
});
