import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstWord } from '../src/first-word.mjs';

test('first word', () => { assert.equal(firstWord('hello world'), 'hello'); });
test('leading whitespace', () => { assert.equal(firstWord('  hi there'), 'hi'); });
test('empty string', () => { assert.equal(firstWord(''), ''); });
test('whitespace only', () => { assert.equal(firstWord('   '), ''); });
