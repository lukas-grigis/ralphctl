import { describe, expect, it } from 'vitest';

import { ProjectName } from './project-name.ts';
import { Slug } from './slug.ts';

describe('ProjectName', () => {
  it('accepts a valid slug-shaped name', () => {
    const r = ProjectName.parse('ralphctl');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('ralphctl');
  });

  it('accepts hyphenated multi-word names', () => {
    const r = ProjectName.parse('my-project-2024');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('my-project-2024');
  });

  it('rejects uppercase', () => {
    const r = ProjectName.parse('MyProject');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('project-name');
      expect(r.error.value).toBe('MyProject');
    }
  });

  it('rejects empty string with project-name field', () => {
    const r = ProjectName.parse('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('project-name');
  });

  it('rejects names longer than 64 chars', () => {
    const r = ProjectName.parse('a'.repeat(65));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('project-name');
  });

  it('rejects non-string input with project-name field', () => {
    const r = ProjectName.parse(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('project-name');
  });

  it('Slug and ProjectName have distinct brands at the type level', () => {
    const sR = Slug.parse('foo');
    const pR = ProjectName.parse('foo');
    expect(sR.ok && pR.ok).toBe(true);
    if (!sR.ok || !pR.ok) return;

    const slug: Slug = sR.value;
    const project: ProjectName = pR.value;

    // @ts-expect-error a Slug cannot satisfy ProjectName
    const _bad1: ProjectName = slug;
    // @ts-expect-error a ProjectName cannot satisfy Slug
    const _bad2: Slug = project;

    // suppress unused-var noise
    void _bad1;
    void _bad2;
  });

  it('trustString returns the input typed as a ProjectName', () => {
    const p: ProjectName = ProjectName.trustString('already-validated');
    expect(p).toBe('already-validated');
  });
});
