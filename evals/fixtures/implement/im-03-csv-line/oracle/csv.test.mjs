import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvLine } from '../src/index.mjs';

test('plain', () => { assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']); });
test('quoted comma', () => { assert.deepEqual(parseCsvLine('"a,b",c'), ['a,b', 'c']); });
test('doubled quote', () => { assert.deepEqual(parseCsvLine('"say ""hi""",x'), ['say "hi"', 'x']); });
test('empty middle field', () => { assert.deepEqual(parseCsvLine('a,,c'), ['a', '', 'c']); });
test('empty line', () => { assert.deepEqual(parseCsvLine(''), ['']); });
test('trailing comma', () => { assert.deepEqual(parseCsvLine('a,'), ['a', '']); });
test('quoted empty', () => { assert.deepEqual(parseCsvLine('"",x'), ['', 'x']); });
test('no trimming', () => { assert.deepEqual(parseCsvLine(' a , b '), [' a ', ' b ']); });
