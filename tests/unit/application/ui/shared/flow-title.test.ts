import { describe, expect, it } from 'vitest';
import { titleSubject } from '@src/application/ui/shared/flow-title.ts';

describe('titleSubject', () => {
  it('drops the flow-name prefix the section stamp already shows', () => {
    expect(titleSubject('implement', 'Implement — ready to implement · 1ef7c7f5')).toBe(
      'ready to implement · 1ef7c7f5'
    );
  });

  it('matches the prefix case-insensitively (launchers write "Create sprint", the stamp says "Create Sprint")', () => {
    expect(titleSubject('create-sprint', 'Create sprint — Mainline')).toBe('Mainline');
  });

  it('keeps a title that does not start with the flow name', () => {
    expect(titleSubject('plan', 'Custom run name')).toBe('Custom run name');
  });
});
