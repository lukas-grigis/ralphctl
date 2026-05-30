import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { LEARNINGS_LEDGER_FILE, learningsLedgerPath } from '@src/application/flows/_shared/memory/ledger-path.ts';

describe('learningsLedgerPath', () => {
  it('resolves <memoryRoot>/<projectId>/learnings.ndjson', () => {
    const memoryRoot = absolutePath('/data/memory');
    const result = learningsLedgerPath(memoryRoot, 'proj-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.value)).toBe(join('/data/memory', 'proj-1', LEARNINGS_LEDGER_FILE));
  });

  it('is project-scoped — different projects resolve to different paths', () => {
    const memoryRoot = absolutePath('/data/memory');
    const a = learningsLedgerPath(memoryRoot, 'proj-a');
    const b = learningsLedgerPath(memoryRoot, 'proj-b');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(String(a.value)).not.toBe(String(b.value));
  });
});
