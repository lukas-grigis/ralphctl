import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';

test('missing file gives defaults', () => {
  assert.deepEqual(loadConfig('/definitely/not/here.json'), { retries: 3 });
});
test('invalid JSON throws and names the path', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'oc-')), 'bad.json');
  writeFileSync(file, '{ nope');
  assert.throws(() => loadConfig(file), (err) => err.message.includes(file));
});
test('a directory is not a missing file', () => {
  assert.throws(() => loadConfig(tmpdir()), (err) => err.message.includes(tmpdir()));
});
