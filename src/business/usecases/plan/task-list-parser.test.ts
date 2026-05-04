import { describe, expect, it } from 'vitest';
import { buildTasksFromEntries, parseTaskList } from './task-list-parser.ts';

const PROJECT_PATH = '/Users/dev/example';

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Add validation utilities',
    description: 'Shared zod schemas',
    steps: ['Create src/validation/index.ts'],
    verificationCriteria: ['pnpm test passes'],
    projectPath: PROJECT_PATH,
    ...overrides,
  };
}

describe('task-list-parser', () => {
  describe('order field', () => {
    it('defaults to array position when AI omits `order`', () => {
      const result = buildTasksFromEntries([entry({ name: 'first' }), entry({ name: 'second' })]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.order).toBe(1);
      expect(result.value[1]?.order).toBe(2);
    });

    it('defaults to array position when `order` is a non-number', () => {
      const result = buildTasksFromEntries([entry({ order: '1' }), entry({ order: null })]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.order).toBe(1);
      expect(result.value[1]?.order).toBe(2);
    });

    it('defaults to array position when `order` is non-positive', () => {
      const result = buildTasksFromEntries([entry({ order: 0 }), entry({ order: -3 })]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.order).toBe(1);
      expect(result.value[1]?.order).toBe(2);
    });

    it('honours a valid AI-supplied `order`', () => {
      const result = buildTasksFromEntries([entry({ order: 7 }), entry({ order: 9 })]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.order).toBe(7);
      expect(result.value[1]?.order).toBe(9);
    });
  });

  describe('extractJson', () => {
    it('parses a fenced ```json block', () => {
      const raw = `Here is the plan:\n\n\`\`\`json\n[${JSON.stringify(entry())}]\n\`\`\`\n`;
      const result = parseTaskList(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
    });

    it('parses a bare top-level array when no fence is present', () => {
      const raw = `Reasoning text…\n\n[${JSON.stringify(entry())}]\n`;
      const result = parseTaskList(raw);
      expect(result.ok).toBe(true);
    });

    it('fails with invalid-json when no array can be located', () => {
      const result = parseTaskList('I had trouble with this one.');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('parse-error');
    });
  });

  describe('placeholder ids and blockedBy resolution', () => {
    it('resolves numeric placeholder ids ("1" / "2") to real task ids', () => {
      const result = buildTasksFromEntries([
        entry({ id: '1', name: 'first' }),
        entry({ id: '2', name: 'second', blockedBy: ['1'] }),
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value[1]?.blockedBy).toHaveLength(1);
      expect(result.value[1]?.blockedBy[0]).toBe(result.value[0]?.id);
    });

    it('resolves kebab-case placeholder ids', () => {
      const result = buildTasksFromEntries([
        entry({ id: 'auth-setup', name: 'set up auth' }),
        entry({ id: 'wire-routes', name: 'wire routes', blockedBy: ['auth-setup'] }),
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[1]?.blockedBy[0]).toBe(result.value[0]?.id);
    });

    it('resolves 8-hex-by-coincidence placeholders via the placeholder map (not TaskId.parse)', () => {
      // Even though "a1b2c3d4" passes the TaskId regex, we still treat it
      // as an opaque placeholder and remap it to the freshly minted id.
      const result = buildTasksFromEntries([
        entry({ id: 'a1b2c3d4', name: 'first' }),
        entry({ id: 'deadbeef', name: 'second', blockedBy: ['a1b2c3d4'] }),
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[1]?.blockedBy[0]).toBe(result.value[0]?.id);
      // The real ids are freshly generated — they are not the placeholders.
      expect(result.value[0]?.id).not.toBe('a1b2c3d4');
      expect(result.value[1]?.id).not.toBe('deadbeef');
    });

    it('rejects blockedBy references to unknown placeholders', () => {
      const result = buildTasksFromEntries([entry({ id: '1', name: 'first', blockedBy: ['nonexistent'] })]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('parse-error');
      expect(result.error.message).toContain('unknown placeholder');
      expect(result.error.message).toContain('nonexistent');
    });

    it('rejects duplicate placeholder ids', () => {
      const result = buildTasksFromEntries([entry({ id: '1', name: 'first' }), entry({ id: '1', name: 'second' })]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('parse-error');
      expect(result.error.message).toContain('duplicate placeholder');
      expect(result.error.message).toContain("'1'");
    });

    it('rejects self-references in blockedBy', () => {
      const result = buildTasksFromEntries([entry({ id: 'x', name: 'self', blockedBy: ['x'] })]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('parse-error');
      expect(result.error.message).toContain('references itself');
    });

    it('parses entries with no `id` field — they just cannot be referenced', () => {
      const result = buildTasksFromEntries([entry({ name: 'no-id-task' })]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      // A real TaskId was minted for the entry even without a placeholder.
      expect(result.value[0]?.id).toMatch(/^[0-9a-f]{8}$/);
    });

    it('mints a fresh TaskId for every entry (placeholders never leak into the entity)', () => {
      const result = buildTasksFromEntries([
        entry({ id: '1', name: 'first' }),
        entry({ id: 'auth-setup', name: 'second' }),
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.id).not.toBe('1');
      expect(result.value[0]?.id).toMatch(/^[0-9a-f]{8}$/);
      expect(result.value[1]?.id).not.toBe('auth-setup');
      expect(result.value[1]?.id).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});
