import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { absolutePath, slug } from '@tests/fixtures/domain.ts';
import { buildSluggedName } from '@src/integration/persistence/storage.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import {
  LEARNINGS_LEDGER_FILE,
  learningsLedgerPathDirect,
  resolveLearningsLedgerPath,
} from '@src/application/flows/_shared/memory/ledger-path.ts';

describe('learningsLedgerPathDirect', () => {
  it('resolves <memoryRoot>/<projectId>--<projectSlug>/learnings.ndjson', () => {
    const memoryRoot = absolutePath('/data/memory');
    const result = learningsLedgerPathDirect(memoryRoot, 'proj-1', slug('demo'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.value)).toBe(join('/data/memory', 'proj-1--demo', LEARNINGS_LEDGER_FILE));
  });

  it('is project-scoped — different projects resolve to different paths', () => {
    const memoryRoot = absolutePath('/data/memory');
    const a = learningsLedgerPathDirect(memoryRoot, 'proj-a', slug('a'));
    const b = learningsLedgerPathDirect(memoryRoot, 'proj-b', slug('b'));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(String(a.value)).not.toBe(String(b.value));
  });
});

describe('resolveLearningsLedgerPath (tolerant reader)', () => {
  const PROJECT_ID = 'proj-1';

  it('resolves the new <id>--<slug>/ memory dir', async () => {
    const tmp = await makeTmpRoot();
    try {
      const memoryRoot = absolutePath(join(String(tmp.root), 'memory'));
      const dirName = buildSluggedName(PROJECT_ID, 'demo');
      await fs.mkdir(join(String(memoryRoot), dirName), { recursive: true });
      const result = await resolveLearningsLedgerPath(memoryRoot, PROJECT_ID);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(String(result.value)).toBe(join(String(memoryRoot), dirName, LEARNINGS_LEDGER_FILE));
    } finally {
      await tmp.cleanup();
    }
  });

  it('resolves the legacy bare <id>/ memory dir', async () => {
    const tmp = await makeTmpRoot();
    try {
      const memoryRoot = absolutePath(join(String(tmp.root), 'memory'));
      await fs.mkdir(join(String(memoryRoot), PROJECT_ID), { recursive: true });
      const result = await resolveLearningsLedgerPath(memoryRoot, PROJECT_ID);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(String(result.value)).toBe(join(String(memoryRoot), PROJECT_ID, LEARNINGS_LEDGER_FILE));
    } finally {
      await tmp.cleanup();
    }
  });

  it('prefers the new <id>--<slug>/ dir when both forms exist', async () => {
    const tmp = await makeTmpRoot();
    try {
      const memoryRoot = absolutePath(join(String(tmp.root), 'memory'));
      const dirName = buildSluggedName(PROJECT_ID, 'demo');
      await fs.mkdir(join(String(memoryRoot), PROJECT_ID), { recursive: true });
      await fs.mkdir(join(String(memoryRoot), dirName), { recursive: true });
      const result = await resolveLearningsLedgerPath(memoryRoot, PROJECT_ID);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(String(result.value)).toBe(join(String(memoryRoot), dirName, LEARNINGS_LEDGER_FILE));
    } finally {
      await tmp.cleanup();
    }
  });

  it('falls back to the bare <id>/ path when no memory dir exists yet', async () => {
    const tmp = await makeTmpRoot();
    try {
      const memoryRoot = absolutePath(join(String(tmp.root), 'memory'));
      const result = await resolveLearningsLedgerPath(memoryRoot, PROJECT_ID);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(String(result.value)).toBe(join(String(memoryRoot), PROJECT_ID, LEARNINGS_LEDGER_FILE));
    } finally {
      await tmp.cleanup();
    }
  });
});
