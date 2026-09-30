import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/clamp.mjs';

test('below the lower bound', () => { assert.equal(clamp(-5, 0, 10), 0); });
test('above the upper bound', () => { assert.equal(clamp(15, 0, 10), 10); });
test('in range', () => { assert.equal(clamp(5, 0, 10), 5); });
test('on the bounds', () => { assert.equal(clamp(0, 0, 10), 0); assert.equal(clamp(10, 0, 10), 10); });
