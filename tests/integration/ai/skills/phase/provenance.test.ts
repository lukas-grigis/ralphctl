import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import {
  createProvenanceStore,
  deriveStatus,
  hashSkillContent,
  PROVENANCE_FILENAME,
  type ProvenanceStamp,
} from '@src/integration/ai/skills/phase/provenance.ts';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

const BUNDLED = '---\nname: ralphctl-alignment\ndescription: Confirm scope\n---\n\n# Alignment\nbody\n';

const stampFor = (raw: string): ProvenanceStamp => ({
  source: 'bundled',
  skill: 'ralphctl-alignment',
  contentHash: hashSkillContent(raw),
  ralphctlVersion: '9.9.9',
  copiedAt: '2026-07-02T12:00:00Z',
});

describe('hashSkillContent', () => {
  it('is deterministic and returns lowercase sha256 hex', () => {
    const h = hashSkillContent(BUNDLED);
    expect(h).toBe(hashSkillContent(BUNDLED));
    expect(h).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('differs when a single byte changes', () => {
    expect(hashSkillContent(BUNDLED)).not.toBe(hashSkillContent(`${BUNDLED} `));
  });
});

describe('deriveStatus', () => {
  it('reports manual when there is no stamp (a hand-dropped folder)', () => {
    expect(deriveStatus({ folderSkillMdRaw: BUNDLED, stamp: undefined, currentBundledRaw: BUNDLED })).toBe('manual');
  });

  it('reports in-sync when folder matches the stamp and the stamp matches the bundle', () => {
    expect(deriveStatus({ folderSkillMdRaw: BUNDLED, stamp: stampFor(BUNDLED), currentBundledRaw: BUNDLED })).toBe(
      'in-sync'
    );
  });

  it('reports update-available when the bundle moved on but the folder still matches its stamp', () => {
    const newBundled = `${BUNDLED}\nnew upstream line\n`;
    expect(deriveStatus({ folderSkillMdRaw: BUNDLED, stamp: stampFor(BUNDLED), currentBundledRaw: newBundled })).toBe(
      'update-available'
    );
  });

  it('reports locally-modified when the folder diverges from its stamp', () => {
    const editedFolder = `${BUNDLED}\noperator edit\n`;
    expect(deriveStatus({ folderSkillMdRaw: editedFolder, stamp: stampFor(BUNDLED), currentBundledRaw: BUNDLED })).toBe(
      'locally-modified'
    );
  });

  it('lets locally-modified win when the folder is edited AND the bundle also moved on', () => {
    const editedFolder = `${BUNDLED}\noperator edit\n`;
    const newBundled = `${BUNDLED}\nnew upstream line\n`;
    // Both divergences hold; the edit must win so `update` never silently discards it.
    expect(
      deriveStatus({ folderSkillMdRaw: editedFolder, stamp: stampFor(BUNDLED), currentBundledRaw: newBundled })
    ).toBe('locally-modified');
  });
});

describe('createProvenanceStore', () => {
  const store = createProvenanceStore({ writeFile: createAtomicWriteFile() });

  it('round-trips a stamp through write → read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provenance-'));
    const stamp = stampFor(BUNDLED);

    const written = await store.writeProvenance(abs(dir), stamp);
    expect(written.ok).toBe(true);

    // The sidecar lands at the documented filename and is valid pretty-printed JSON on disk.
    const onDisk = await readFile(join(dir, PROVENANCE_FILENAME), 'utf-8');
    expect(JSON.parse(onDisk)).toEqual(stamp);

    const read = await store.readProvenance(abs(dir));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual(stamp);
  });

  it('returns ok(undefined) for an unstamped folder (missing sidecar)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provenance-'));
    const read = await store.readProvenance(abs(dir));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toBeUndefined();
  });

  it('treats a malformed sidecar as a soft signal → ok(undefined)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provenance-'));
    await writeFile(join(dir, PROVENANCE_FILENAME), 'not json at all', 'utf-8');
    const read = await store.readProvenance(abs(dir));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toBeUndefined();
  });

  it('treats a well-formed JSON sidecar missing required fields as ok(undefined)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provenance-'));
    // Valid JSON, wrong shape (no contentHash / wrong source) — still a soft signal, not an error.
    await writeFile(join(dir, PROVENANCE_FILENAME), JSON.stringify({ source: 'bundled', skill: 'x' }), 'utf-8');
    const read = await store.readProvenance(abs(dir));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toBeUndefined();
  });
});
