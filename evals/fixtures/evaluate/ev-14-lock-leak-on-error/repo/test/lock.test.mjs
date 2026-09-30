import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLock } from '../src/lock.mjs';

test('a lock cannot be taken twice', () => {
  const lock = createLock();
  lock.acquire();
  assert.throws(() => lock.acquire());
  lock.release();
  lock.acquire();
});
