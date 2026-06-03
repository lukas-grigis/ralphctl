import { describe, expect, it } from 'vitest';
import { buildRawUrl, diffStatus, type SkillSource } from '../../../scripts/sync-skills.ts';

const entry: SkillSource = {
  name: 'ralphctl-debugging-and-error-recovery',
  repo: 'addyosmani/agent-skills',
  path: 'skills/debugging-and-error-recovery/SKILL.md',
  ref: 'main',
  license: 'MIT',
  upstreamUrl: 'https://github.com/addyosmani/agent-skills',
};

describe('buildRawUrl', () => {
  it('builds the raw.githubusercontent.com URL from a manifest entry', () => {
    expect(buildRawUrl(entry)).toBe(
      'https://raw.githubusercontent.com/addyosmani/agent-skills/main/skills/debugging-and-error-recovery/SKILL.md'
    );
  });

  it('honours a non-default ref', () => {
    expect(buildRawUrl({ ...entry, ref: 'v2' })).toBe(
      'https://raw.githubusercontent.com/addyosmani/agent-skills/v2/skills/debugging-and-error-recovery/SKILL.md'
    );
  });
});

describe('diffStatus', () => {
  it('returns UNCHANGED when fetched matches the cached copy', () => {
    expect(diffStatus('# Skill\nbody\n', '# Skill\nbody\n')).toBe('UNCHANGED');
  });

  it('returns DRIFTED when fetched differs from the cached copy', () => {
    expect(diffStatus('# Skill\nnew body\n', '# Skill\nold body\n')).toBe('DRIFTED');
  });

  it('returns DRIFTED on first sync (no cached copy)', () => {
    expect(diffStatus('# Skill\nbody\n', undefined)).toBe('DRIFTED');
  });
});
