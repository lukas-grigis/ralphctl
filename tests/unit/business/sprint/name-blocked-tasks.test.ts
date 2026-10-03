import { describe, expect, it } from 'vitest';
import { nameBlockedTasks } from '@src/business/sprint/name-blocked-tasks.ts';

// Built with fromCharCode so no literal ESC byte lands in the repository.
const ESC = String.fromCharCode(0x1b);

describe('nameBlockedTasks', () => {
  it('strips terminal escape bytes from AI-authored task names', () => {
    const named = nameBlockedTasks([{ name: `${ESC}[31mFix login${ESC}[0m` }]);
    expect(named).toBe('[31mFix login[0m');
    expect(named).not.toContain(ESC);
  });

  it('names the first five and collapses the rest into "and N more"', () => {
    const blocked = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name }));
    expect(nameBlockedTasks(blocked)).toBe('a, b, c, d, e, and 1 more');
  });

  it('joins without a tail when five or fewer are blocked', () => {
    expect(nameBlockedTasks([{ name: 'a' }, { name: 'b' }])).toBe('a, b');
  });
});
