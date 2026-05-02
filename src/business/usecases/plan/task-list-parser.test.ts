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
});
