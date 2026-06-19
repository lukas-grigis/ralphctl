/**
 * Unit tests for the data-version marker (Wave 2 migration engine).
 *
 * Covers the gate semantics the consent splash relies on:
 *  - absent marker ⇒ v1 ⇒ migration pending;
 *  - marker == CURRENT ⇒ not pending;
 *  - marker > CURRENT (a newer ralphctl wrote it, then a downgrade) ⇒ NOT pending (forward-compat,
 *    we never downgrade data);
 *  - corrupt / non-JSON marker ⇒ degrades to v1 (re-offer; tolerant readers cover the gap);
 *  - a round-trip stamps both fields.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import {
  CURRENT_DATA_VERSION,
  DATA_VERSION_FILENAME,
  needsMigration,
  readDataVersion,
  versionMarkerPath,
  writeDataVersion,
} from '@src/integration/persistence/data-migration/version-marker.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ralph-marker-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const dataRoot = () => absolutePath(root);

describe('readDataVersion / needsMigration', () => {
  it('absent marker → v1, migration pending', async () => {
    expect(await readDataVersion(dataRoot())).toEqual({ dataVersion: 1, lastWrittenByAppVersion: '' });
    expect(await needsMigration(dataRoot())).toBe(true);
  });

  it('marker at CURRENT → not pending', async () => {
    await writeDataVersion(dataRoot(), { dataVersion: CURRENT_DATA_VERSION, lastWrittenByAppVersion: '0.12.1' });
    expect(await needsMigration(dataRoot())).toBe(false);
  });

  it('marker GREATER than CURRENT → not pending (forward-compat, never downgrade)', async () => {
    await writeDataVersion(dataRoot(), { dataVersion: CURRENT_DATA_VERSION + 5, lastWrittenByAppVersion: '99.0.0' });
    expect(await needsMigration(dataRoot())).toBe(false);
  });

  it('corrupt JSON marker → degrades to v1 (pending)', async () => {
    await fs.writeFile(join(root, DATA_VERSION_FILENAME), '{ not valid json', 'utf8');
    expect(await readDataVersion(dataRoot())).toEqual({ dataVersion: 1, lastWrittenByAppVersion: '' });
    expect(await needsMigration(dataRoot())).toBe(true);
  });

  it('marker with a non-numeric dataVersion → degrades to v1', async () => {
    await fs.writeFile(join(root, DATA_VERSION_FILENAME), JSON.stringify({ dataVersion: 'two' }), 'utf8');
    expect(await readDataVersion(dataRoot())).toEqual({ dataVersion: 1, lastWrittenByAppVersion: '' });
  });
});

describe('writeDataVersion', () => {
  it('stamps both dataVersion and lastWrittenByAppVersion', async () => {
    const res = await writeDataVersion(dataRoot(), { dataVersion: 2, lastWrittenByAppVersion: '0.12.1' });
    expect(res.ok).toBe(true);
    const onDisk = JSON.parse(await fs.readFile(versionMarkerPath(dataRoot()), 'utf8'));
    expect(onDisk).toEqual({ dataVersion: 2, lastWrittenByAppVersion: '0.12.1' });
    expect(await readDataVersion(dataRoot())).toEqual({ dataVersion: 2, lastWrittenByAppVersion: '0.12.1' });
  });
});
