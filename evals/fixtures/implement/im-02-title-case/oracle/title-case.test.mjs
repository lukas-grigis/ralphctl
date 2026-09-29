import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleCase } from '../src/index.mjs';

test('basic', () => { assert.equal(titleCase('hello world'), 'Hello World'); });
test('mixed case and extra whitespace', () => { assert.equal(titleCase('  hello   WORLD '), 'Hello World'); });
test('single word', () => { assert.equal(titleCase('x'), 'X'); });
test('empty string', () => { assert.equal(titleCase(''), ''); });
