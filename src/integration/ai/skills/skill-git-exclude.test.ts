import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { addRalphctlSkillsExclude, removeRalphctlSkillsExclude } from './skill-git-exclude.ts';

function uniqueRoot(): string {
  return join(
    tmpdir(),
    `ralphctl-skill-git-exclude-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  );
}

const BEGIN_MARKER = '# >>> ralphctl-managed-skills (do not edit) >>>';
const END_MARKER = '# <<< ralphctl-managed-skills <<<';

describe('skill-git-exclude', () => {
  let root: string;
  let cwd: AbsolutePath;
  let excludePath: string;

  beforeEach(async () => {
    root = uniqueRoot();
    cwd = AbsolutePath.trustString(root);
    await mkdir(root, { recursive: true });
    excludePath = join(root, '.git', 'info', 'exclude');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('add: no-op when <cwd>/.git/ does not exist', async () => {
    const r = await addRalphctlSkillsExclude(cwd);
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, '.git'))).toBe(false);
  });

  it('add: no-op when .git is a worktree pointer file (not a directory)', async () => {
    // `.git` as a regular file simulates a linked worktree or submodule.
    await writeFile(join(root, '.git'), 'gitdir: /elsewhere\n', 'utf8');
    const r = await addRalphctlSkillsExclude(cwd);
    expect(r.ok).toBe(true);
    // Should not have created an info dir under the file.
    expect(existsSync(join(root, '.git', 'info'))).toBe(false);
  });

  it('add: writes the marker block when .git/ exists and exclude file is missing', async () => {
    await mkdir(join(root, '.git'), { recursive: true });
    const r = await addRalphctlSkillsExclude(cwd);
    expect(r.ok).toBe(true);
    const body = await readFile(excludePath, 'utf8');
    expect(body).toContain(BEGIN_MARKER);
    expect(body).toContain('.claude/skills/');
    expect(body).toContain(END_MARKER);
    expect(body.endsWith('\n')).toBe(true);
  });

  it('add: appends after existing user excludes without disturbing them', async () => {
    await mkdir(join(root, '.git', 'info'), { recursive: true });
    await writeFile(excludePath, '# user exclude\n*.bak\nlocal/\n', 'utf8');
    const r = await addRalphctlSkillsExclude(cwd);
    expect(r.ok).toBe(true);
    const body = await readFile(excludePath, 'utf8');
    expect(body.startsWith('# user exclude\n*.bak\nlocal/\n')).toBe(true);
    expect(body).toContain(BEGIN_MARKER);
    expect(body).toContain(END_MARKER);
  });

  it('add: idempotent — repeated calls do not duplicate the block', async () => {
    await mkdir(join(root, '.git'), { recursive: true });
    await addRalphctlSkillsExclude(cwd);
    await addRalphctlSkillsExclude(cwd);
    await addRalphctlSkillsExclude(cwd);
    const body = await readFile(excludePath, 'utf8');
    const beginCount = body.split(BEGIN_MARKER).length - 1;
    const endCount = body.split(END_MARKER).length - 1;
    expect(beginCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it('add: handles a body without a trailing newline', async () => {
    await mkdir(join(root, '.git', 'info'), { recursive: true });
    await writeFile(excludePath, '# user exclude\n*.bak', 'utf8');
    const r = await addRalphctlSkillsExclude(cwd);
    expect(r.ok).toBe(true);
    const body = await readFile(excludePath, 'utf8');
    // user lines preserved
    expect(body).toContain('# user exclude\n*.bak');
    // and the block is appended cleanly
    expect(body).toContain(`\n${BEGIN_MARKER}\n`);
  });

  it('remove: no-op when <cwd>/.git/ does not exist', async () => {
    const r = await removeRalphctlSkillsExclude(cwd);
    expect(r.ok).toBe(true);
  });

  it('remove: no-op when exclude file does not exist', async () => {
    await mkdir(join(root, '.git', 'info'), { recursive: true });
    const r = await removeRalphctlSkillsExclude(cwd);
    expect(r.ok).toBe(true);
    expect(existsSync(excludePath)).toBe(false);
  });

  it('remove: strips the marker block, leaves user excludes intact', async () => {
    await mkdir(join(root, '.git'), { recursive: true });
    await addRalphctlSkillsExclude(cwd);
    // Add some user content alongside the marker block.
    const before = await readFile(excludePath, 'utf8');
    await writeFile(excludePath, `# user exclude\n*.bak\n${before}# trailing user line\n`, 'utf8');

    const r = await removeRalphctlSkillsExclude(cwd);
    expect(r.ok).toBe(true);
    const after = await readFile(excludePath, 'utf8');
    expect(after).not.toContain(BEGIN_MARKER);
    expect(after).not.toContain(END_MARKER);
    expect(after).not.toContain('.claude/skills/');
    expect(after).toContain('# user exclude');
    expect(after).toContain('*.bak');
    expect(after).toContain('# trailing user line');
  });

  it('remove: leaves an exclude file with no marker block unchanged', async () => {
    await mkdir(join(root, '.git', 'info'), { recursive: true });
    const original = '# user exclude\n*.bak\n';
    await writeFile(excludePath, original, 'utf8');
    const r = await removeRalphctlSkillsExclude(cwd);
    expect(r.ok).toBe(true);
    expect(await readFile(excludePath, 'utf8')).toBe(original);
  });

  it('remove: tolerates an unterminated BEGIN marker (recovers via EOF strip)', async () => {
    // Simulate a crash mid-write — BEGIN appended, END missing.
    await mkdir(join(root, '.git', 'info'), { recursive: true });
    await writeFile(excludePath, `# user exclude\n${BEGIN_MARKER}\n.claude/skills/\n`, 'utf8');
    const r = await removeRalphctlSkillsExclude(cwd);
    expect(r.ok).toBe(true);
    const after = await readFile(excludePath, 'utf8');
    expect(after).not.toContain(BEGIN_MARKER);
    expect(after).not.toContain('.claude/skills/');
    expect(after).toContain('# user exclude');
  });

  it('add then remove restores the file to its prior contents (modulo a trailing newline)', async () => {
    await mkdir(join(root, '.git', 'info'), { recursive: true });
    const original = '# user exclude\n*.bak\nlocal/\n';
    await writeFile(excludePath, original, 'utf8');

    await addRalphctlSkillsExclude(cwd);
    await removeRalphctlSkillsExclude(cwd);

    const after = await readFile(excludePath, 'utf8');
    expect(after).toBe(original);
  });
});
