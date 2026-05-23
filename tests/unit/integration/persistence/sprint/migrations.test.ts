import { describe, expect, it } from 'vitest';
import { fromJsonSprint } from '@src/integration/persistence/sprint/sprint.schema.ts';

const SPRINT_ID = '0193ed2b-1234-7abc-8def-0123456789ab';
const PROJECT_ID = '01900000-0000-7000-8000-00000000aaaa';

describe('sprintMigrations — v0 → v1 round-trip', () => {
  it('migrates a pre-Wave-8 file without `schemaVersion`', () => {
    const legacy = {
      id: SPRINT_ID,
      slug: 'my-sprint',
      name: 'My Sprint',
      tickets: [],
      projectId: PROJECT_ID,
      status: 'draft',
      plannedAt: null,
      activatedAt: null,
      reviewAt: null,
      doneAt: null,
    };
    const parsed = fromJsonSprint(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(String(parsed.value.id)).toBe(SPRINT_ID);
    expect(parsed.value.status).toBe('draft');
  });

  it('parses a v1 file unchanged (no migration runs)', () => {
    const current = {
      schemaVersion: 1,
      id: SPRINT_ID,
      slug: 'my-sprint',
      name: 'My Sprint',
      tickets: [],
      projectId: PROJECT_ID,
      status: 'draft' as const,
      plannedAt: null,
      activatedAt: null,
      reviewAt: null,
      doneAt: null,
    };
    const parsed = fromJsonSprint(current);
    expect(parsed.ok).toBe(true);
  });
});
