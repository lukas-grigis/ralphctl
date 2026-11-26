import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRawUrl,
  cleanRoomNames,
  diffStatus,
  formatCommitHint,
  parseManifest,
  serializeLock,
  skillFiles,
  type SkillSource,
} from '../../../scripts/sync-skills.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const BUNDLED = join(ROOT, 'src', 'integration', 'ai', 'skills', 'bundled');

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

describe('buildRawUrl with a pinned SHA and extra path', () => {
  it('uses the SHA and the given upstream path', () => {
    expect(buildRawUrl(entry, 'abc123', 'skills/x/references/y.md')).toBe(
      'https://raw.githubusercontent.com/addyosmani/agent-skills/abc123/skills/x/references/y.md'
    );
  });
});

describe('skillFiles', () => {
  it('lists SKILL.md first and resolves extras against the upstream skill folder', () => {
    const files = skillFiles({ ...entry, extraPaths: ['references/a.md', 'B.md'] });
    expect(files).toEqual([
      { rel: 'SKILL.md', upstreamPath: 'skills/debugging-and-error-recovery/SKILL.md' },
      { rel: 'references/a.md', upstreamPath: 'skills/debugging-and-error-recovery/references/a.md' },
      { rel: 'B.md', upstreamPath: 'skills/debugging-and-error-recovery/B.md' },
    ]);
  });
});

describe('parseManifest', () => {
  const ok = { skills: [entry] };

  it('accepts a valid manifest', () => {
    expect(parseManifest(ok).skills).toHaveLength(1);
  });

  it.each([
    ['bad name', { ...entry, name: '../evil' }],
    ['bad repo', { ...entry, repo: 'not-a-repo' }],
    ['non-md path', { ...entry, path: 'skills/x/SKILL.txt' }],
    ['traversal in path', { ...entry, path: 'skills/../x.md' }],
    ['yaml extra', { ...entry, extraPaths: ['agents/openai.yaml'] }],
    ['agents/ extra', { ...entry, extraPaths: ['agents/notes.md'] }],
    ['scripts/ extra', { ...entry, extraPaths: ['scripts/readme.md'] }],
    ['absolute extra', { ...entry, extraPaths: ['/etc/x.md'] }],
    ['bad url', { ...entry, upstreamUrl: 'nope' }],
  ])('rejects %s', (_label, bad) => {
    expect(() => parseManifest({ skills: [bad] })).toThrow(/invalid manifest/);
  });

  it('rejects duplicate names', () => {
    expect(() => parseManifest({ skills: [entry, entry] })).toThrow(/duplicate/);
  });
});

describe('formatCommitHint', () => {
  it('names the last commit touching the path', () => {
    const hint = formatCommitHint([
      {
        sha: '0123456789abcdef',
        html_url: 'https://x/c',
        commit: { message: 'rename skill\n\nbody', committer: { date: '2026-01-01' } },
      },
    ]);
    expect(hint).toContain('0123456789ab');
    expect(hint).toContain('rename skill');
  });

  it('reports an empty history', () => {
    expect(formatCommitHint([])).toMatch(/ever touched/);
  });
});

describe('serializeLock', () => {
  it('sorts skills and ends with a newline', () => {
    const f = { repo: 'a/b', ref: 'main', sha: 'x', files: ['SKILL.md'] };
    const out = serializeLock({ version: 1, skills: { 'ralphctl-b': f, 'ralphctl-a': f } });
    expect(out.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(out).skills)).toEqual(['ralphctl-a', 'ralphctl-b']);
  });
});

describe('manifest <-> bundled folders parity (read at runtime)', () => {
  const manifest = parseManifest(JSON.parse(readFileSync(join(ROOT, 'scripts', 'skills-sources.json'), 'utf8')));
  const folders = readdirSync(BUNDLED, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it('every manifest name maps to a bundled folder', () => {
    for (const s of manifest.skills) expect(folders, s.name).toContain(s.name);
  });

  it('every $cleanRoom name maps to a bundled folder', () => {
    for (const name of cleanRoomNames(manifest)) expect(folders, name).toContain(name);
  });

  it('every bundled folder with a license frontmatter is in the manifest', () => {
    const managed = new Set(manifest.skills.map((s) => s.name));
    for (const f of folders) {
      const text = readFileSync(join(BUNDLED, f, 'SKILL.md'), 'utf8');
      const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
      if (/^license:/m.test(front))
        expect(managed.has(f), `${f} has license frontmatter but no manifest entry`).toBe(true);
    }
  });
});
