import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLock } from '../src/lock.mjs';
import { withLock } from '../src/with-lock.mjs';

test('lock is free after a rejection', async () => {
  const lock = createLock();
  await assert.rejects(withLock(lock, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(lock.held, false);
  await withLock(lock, async () => 1);
});
test('lock is free after success', async () => {
  const lock = createLock();
  assert.equal(await withLock(lock, async () => 'x'), 'x');
  assert.equal(lock.held, false);
});
