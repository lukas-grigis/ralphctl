import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDir } from '../src/list-dir.mjs';

test('lists sorted entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oracle-'));
  writeFileSync(join(dir, 'b.txt'), '');
  writeFileSync(join(dir, 'a.txt'), '');
  assert.deepEqual(listDir(dir), ['a.txt', 'b.txt']);
});

test('shell metacharacters in the argument are not executed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oracle-'));
  const marker = join(dir, 'pwned');
  try {
    listDir(`${dir}; touch ${marker}`);
  } catch {
    // a rejected path is fine — only the side effect matters
  }
  assert.equal(existsSync(marker), false);
});
