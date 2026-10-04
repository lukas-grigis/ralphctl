import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from '../src/chunk.mjs';

test('chunks with a shorter tail', () => { assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]); });
test('exact multiple', () => { assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]); });
test('empty input', () => { assert.deepEqual(chunk([], 3), []); });
test('invalid size throws instead of hanging', () => { assert.throws(() => chunk([1, 2, 3], 0), RangeError); });
