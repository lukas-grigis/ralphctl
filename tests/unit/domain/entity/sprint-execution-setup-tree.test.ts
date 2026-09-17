import { describe, expect, it } from 'vitest';
import {
  recordSetupTree,
  SETUP_TREE_SEEN_PATHS_MAX,
  setupTreeRecordCovers,
  type SetupTreeRecord,
} from '@src/domain/entity/sprint-execution.ts';

const numbered = (count: number, name: (i: string) => string): string[] =>
  Array.from({ length: count }, (_, i) => name(String(i).padStart(4, '0')));

/** Every input path is still covered by the record — the property the collapse must never break. */
const coversAll = (record: SetupTreeRecord, paths: readonly string[]): boolean =>
  paths.every((path) => setupTreeRecordCovers(record, path));

describe('setupTreeRecordCovers', () => {
  const record = recordSetupTree('kept', ['pnpm-lock.yaml', 'gen/']);

  it('covers a listed path and anything under a listed directory', () => {
    expect(setupTreeRecordCovers(record, 'pnpm-lock.yaml')).toBe(true);
    expect(setupTreeRecordCovers(record, 'gen/')).toBe(true);
    expect(setupTreeRecordCovers(record, 'gen/deep/types.ts')).toBe(true);
  });

  it('does not treat a file entry as a directory, or a sibling with a shared prefix as inside one', () => {
    const files = recordSetupTree('kept', ['gen']);
    expect(setupTreeRecordCovers(files, 'gen/types.ts')).toBe(false);
    expect(setupTreeRecordCovers(record, 'generated.ts')).toBe(false);
  });
});

describe('recordSetupTree', () => {
  it('keeps a list that fits as given, minus duplicates', () => {
    expect(recordSetupTree('unchanged', ['b.ts', 'a/', 'b.ts'])).toStrictEqual({
      outcome: 'unchanged',
      seenPaths: ['b.ts', 'a/'],
      seenPathsTruncated: false,
    });
  });

  it('collapses an overflowing directory into one entry instead of dropping paths', () => {
    const paths = ['pnpm-lock.yaml', ...numbered(250, (i) => `gen/f${i}.ts`), 'src/wip.ts'];
    const record = recordSetupTree('kept', paths);

    expect(record).toStrictEqual({
      outcome: 'kept',
      seenPaths: ['pnpm-lock.yaml', 'gen/', 'src/wip.ts'],
      seenPathsTruncated: false,
    });
    expect(coversAll(record, paths)).toBe(true);
  });

  it('collapses only as far up as it has to', () => {
    const paths = [
      ...numbered(250, (i) => `packages/a/gen/f${i}.ts`),
      ...numbered(250, (i) => `packages/b/gen/f${i}.ts`),
      'packages/c/index.ts',
    ];
    const record = recordSetupTree('stashed', paths);

    expect(record.seenPaths).toStrictEqual(['packages/a/gen/', 'packages/b/gen/', 'packages/c/index.ts']);
    expect(record.seenPathsTruncated).toBe(false);
    expect(coversAll(record, paths)).toBe(true);
  });

  it('collapses the biggest directories first and leaves the rest precise', () => {
    // 150 + 60 + 2 = 212 paths: collapsing `big/` alone brings it to 63, so `mid/` stays listed.
    const paths = [
      ...numbered(2, (i) => `small/f${i}.ts`),
      ...numbered(60, (i) => `mid/f${i}.ts`),
      ...numbered(150, (i) => `big/f${i}.ts`),
    ];
    const record = recordSetupTree('kept', paths);

    expect(record.seenPaths).toHaveLength(63);
    expect(record.seenPaths).toContain('big/');
    expect(record.seenPaths).not.toContain('mid/');
    expect(record.seenPaths.slice(0, 2)).toStrictEqual(['small/f0000.ts', 'small/f0001.ts']);
    expect(record.seenPathsTruncated).toBe(false);
    expect(coversAll(record, paths)).toBe(true);
  });

  it('collapses entries that sit at different depths under the same directory', () => {
    const paths = numbered(210, (i) => (Number(i) % 2 === 0 ? `out/x${i}/leaf.js` : `out/y${i}.js`));
    const record = recordSetupTree('kept', paths);

    expect(record.seenPaths).toStrictEqual(['out/']);
    expect(coversAll(record, paths)).toBe(true);
  });

  it('drops entries a recorded directory already covers', () => {
    const paths = ['gen/', ...numbered(SETUP_TREE_SEEN_PATHS_MAX, (i) => `gen/f${i}.ts`)];
    expect(recordSetupTree('kept', paths).seenPaths).toStrictEqual(['gen/']);
  });

  it('keeps the introduced-first order through the collapse', () => {
    const paths = ['z-first.ts', ...numbered(250, (i) => `a/f${i}.ts`), 'b-last.ts'];
    expect(recordSetupTree('kept', paths).seenPaths).toStrictEqual(['z-first.ts', 'a/', 'b-last.ts']);
  });

  it('flags the record as truncated only when even top-level directories do not fit', () => {
    const paths = numbered(SETUP_TREE_SEEN_PATHS_MAX + 1, (i) => `top${i}.ts`);
    const record = recordSetupTree('kept', paths);

    expect(record.seenPaths).toHaveLength(SETUP_TREE_SEEN_PATHS_MAX);
    expect(record.seenPaths[0]).toBe('top0000.ts');
    expect(record.seenPathsTruncated).toBe(true);
  });

  it('handles a very large list without blowing the stack', () => {
    const paths = numbered(9000, (i) => `vendor/pkg${String(Number(i) % 300)}/f${i}.js`);
    const record = recordSetupTree('kept', paths);

    expect(record.seenPaths).toStrictEqual(['vendor/']);
    expect(coversAll(record, paths)).toBe(true);
  });
});
