import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import type { ReproductionArtifact } from '@src/application/flows/implement/leaves/reproduce.ts';
import {
  loadReproductionArtifact,
  removeReproductionArtifact,
  reproductionArtifactFile,
  saveReproductionArtifact,
} from '@src/application/flows/implement/leaves/reproduction-artifact.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

const ARTIFACT: ReproductionArtifact = {
  testPath: 'tests/unit/foo.test.ts',
  runCommand: 'npx vitest run tests/unit/foo.test.ts',
  observedFailure: 'AssertionError: expected 200 to equal 404',
  relevantTests: ['tests/unit/bar.test.ts'],
  checksum: 'a'.repeat(64),
};

describe('reproduction-artifact — the saved reproduction a relaunch reuses', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let reproduceDir: AbsolutePath;
  let file: AbsolutePath;

  beforeEach(async () => {
    root = await makeTmpRoot();
    reproduceDir = absolutePath(join(String(root.root), 'implement', 'task-1', 'reproduce'));
    const resolved = reproductionArtifactFile(reproduceDir);
    if (!resolved.ok) throw resolved.error;
    file = resolved.value;
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const writeRaw = async (content: string): Promise<void> => {
    await fs.mkdir(String(reproduceDir), { recursive: true });
    await fs.writeFile(String(file), content, 'utf8');
  };

  it('lives next to the reproduce session files, as artifact.json', () => {
    expect(String(file)).toBe(join(String(reproduceDir), 'artifact.json'));
  });

  it('round-trips a saved artifact field for field', async () => {
    const saved = await saveReproductionArtifact(createAtomicWriteFile(), file, ARTIFACT);
    expect(saved.ok).toBe(true);

    const loaded = await loadReproductionArtifact(file);
    expect(loaded.ok && loaded.value).toStrictEqual(ARTIFACT);
  });

  it('stamps a schema version on disk so a later shape change can be told apart', async () => {
    await saveReproductionArtifact(createAtomicWriteFile(), file, ARTIFACT);
    const raw = JSON.parse(await fs.readFile(String(file), 'utf8')) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(1);
  });

  it('surfaces a failed write to the caller instead of swallowing it', async () => {
    const failing: WriteFile = async () => Result.error(new StorageError({ subCode: 'io', message: 'disk full' }));
    const saved = await saveReproductionArtifact(failing, file, ARTIFACT);
    expect(saved.ok).toBe(false);
  });

  it('reads a missing file as "nothing saved", not as an error', async () => {
    const loaded = await loadReproductionArtifact(file);
    expect(loaded.ok && loaded.value).toBeUndefined();
  });

  it('rejects a file that is not JSON', async () => {
    await writeRaw('{ not json');
    const loaded = await loadReproductionArtifact(file);
    expect(loaded.ok).toBe(false);
  });

  it('rejects an unknown schema version', async () => {
    await writeRaw(JSON.stringify({ ...ARTIFACT, schemaVersion: 2 }));
    const loaded = await loadReproductionArtifact(file);
    expect(loaded.ok).toBe(false);
  });

  it('rejects a file that lacks a field the reuse depends on', async () => {
    const withoutChecksum: Record<string, unknown> = { ...ARTIFACT, schemaVersion: 1 };
    delete withoutChecksum.checksum;
    await writeRaw(JSON.stringify(withoutChecksum));
    const loaded = await loadReproductionArtifact(file);
    expect(loaded.ok).toBe(false);
  });

  it('removes a saved artifact, and treats removing a missing one as done', async () => {
    await saveReproductionArtifact(createAtomicWriteFile(), file, ARTIFACT);

    const removed = await removeReproductionArtifact(file);
    expect(removed.ok).toBe(true);
    const loaded = await loadReproductionArtifact(file);
    expect(loaded.ok && loaded.value).toBeUndefined();

    const again = await removeReproductionArtifact(file);
    expect(again.ok).toBe(true);
  });
});
