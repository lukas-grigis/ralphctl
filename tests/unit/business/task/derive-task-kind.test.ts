import { describe, expect, it } from 'vitest';
import type { Task } from '@src/domain/entity/task.ts';
import { deriveTaskKind, type TaskKind } from '@src/business/task/derive-task-kind.ts';

/**
 * `deriveTaskKind` reads only `name` + `description`; the rest of the Task shape is irrelevant
 * to the classifier, so the table builds the two prose fields and casts. Table-driven so a new
 * keyword bucket adds one row.
 */
const task = (name: string, description?: string): Task =>
  ({ name, ...(description !== undefined ? { description } : {}) }) as unknown as Task;

const cases: ReadonlyArray<{ name: string; description?: string; expected: TaskKind }> = [
  // bugfix
  { name: 'Fix the crash on startup', expected: 'bugfix' },
  { name: 'Patch regression in parser', expected: 'bugfix' },
  { name: 'Investigate', description: 'a nasty bug in the scheduler', expected: 'bugfix' },
  // test
  { name: 'Add tests for the wave scheduler', expected: 'test' },
  { name: 'Improve coverage', description: 'add a fixture for the diamond case', expected: 'test' },
  // docs
  { name: 'Update the README', expected: 'docs' },
  { name: 'Document the new flag', description: 'in the changelog', expected: 'docs' },
  // refactor
  { name: 'Refactor the launcher', expected: 'refactor' },
  { name: 'Extract the prologue', description: 'cleanup duplicated wiring', expected: 'refactor' },
  // chore
  { name: 'Bump the lint config', expected: 'chore' },
  { name: 'Upgrade dependencies', expected: 'chore' },
  // feature
  { name: 'Implement the distill sub-chain', expected: 'feature' },
  { name: 'Add support for parallel waves', expected: 'feature' },
  // bugfix precedence: matches both "fix" and "refactor" → bugfix wins (earlier in table)
  { name: 'Fix and refactor the merge reducer', expected: 'bugfix' },
  // word-boundary: "featured" / "fastest" must NOT match "feature" / "test"
  { name: 'Show the featured items in the gallery', expected: 'other' },
  { name: 'Find the fastest path', expected: 'other' },
  // fallback
  { name: 'Wibble the frobnicator', expected: 'other' },
  { name: '', expected: 'other' },
];

describe('deriveTaskKind', () => {
  it.each(cases)('classifies "$name" / "$description" as $expected', ({ name, description, expected }) => {
    expect(deriveTaskKind(task(name, description))).toBe(expected);
  });
});
