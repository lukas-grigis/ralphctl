import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { slug } from '@tests/fixtures/domain.ts';
import {
  buildSluggedName,
  parseIdFromName,
  projectFile,
  projectsDir,
  resolveMemoryDir,
  resolveProjectPath,
  resolveSprintDir,
  sprintDir,
  sprintsDir,
} from '@src/integration/persistence/storage.ts';

describe('buildSluggedName / parseIdFromName', () => {
  it('round-trips an id ⇄ <id>--<slug> name (split on the FIRST --)', () => {
    const id = '01900000-0000-7000-8000-0000000000aa';
    const name = buildSluggedName(id, 'my-cool-slug');
    expect(name).toBe(`${id}--my-cool-slug`);
    expect(parseIdFromName(name)).toBe(id);
  });

  it('parses the legacy bare <id> name (no separator) back to the id', () => {
    const id = '01900000-0000-7000-8000-0000000000aa';
    expect(parseIdFromName(id)).toBe(id);
  });

  it('strips a trailing .json before recovering the id', () => {
    const id = '01900000-0000-7000-8000-0000000000aa';
    expect(parseIdFromName(`${id}--demo.json`)).toBe(id);
    expect(parseIdFromName(`${id}.json`)).toBe(id);
  });
});

describe('resolveProjectPath (tolerant id-prefix resolver)', () => {
  let root: AbsolutePath;
  let cleanup: () => Promise<void>;
  const ID = ProjectId.generate();

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = tmp.root;
    cleanup = tmp.cleanup;
    await fs.mkdir(projectsDir(root), { recursive: true });
  });
  afterEach(async () => cleanup());

  it('U2 — finds the new <id>--<slug>.json name', async () => {
    const path = projectFile(root, ID, slug('demo'));
    await fs.writeFile(path, '{}');
    expect(await resolveProjectPath(root, ID)).toBe(path);
  });

  it('U3 — finds the legacy bare <id>.json name', async () => {
    const legacy = join(projectsDir(root), `${String(ID)}.json`);
    await fs.writeFile(legacy, '{}');
    expect(await resolveProjectPath(root, ID)).toBe(legacy);
  });

  it('U4 — prefers the new name when both forms exist', async () => {
    const legacy = join(projectsDir(root), `${String(ID)}.json`);
    const slugged = projectFile(root, ID, slug('demo'));
    await fs.writeFile(legacy, '{}');
    await fs.writeFile(slugged, '{}');
    expect(await resolveProjectPath(root, ID)).toBe(slugged);
  });

  it('U5 — returns undefined when neither exists', async () => {
    expect(await resolveProjectPath(root, ID)).toBeUndefined();
  });

  it('U6 — ignores non-matching / garbage entries (different id, non-uuid)', async () => {
    await fs.writeFile(join(projectsDir(root), 'not-a-uuid.json'), '{}');
    await fs.writeFile(join(projectsDir(root), `${String(ProjectId.generate())}--other.json`), '{}');
    await fs.writeFile(join(projectsDir(root), '.DS_Store'), 'junk');
    expect(await resolveProjectPath(root, ID)).toBeUndefined();
  });
});

describe('resolveSprintDir (tolerant id-prefix resolver)', () => {
  let root: AbsolutePath;
  let cleanup: () => Promise<void>;
  const ID = SprintId.generate();

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = tmp.root;
    cleanup = tmp.cleanup;
    await fs.mkdir(sprintsDir(root), { recursive: true });
  });
  afterEach(async () => cleanup());

  it('finds the new <id>--<slug>/ dir', async () => {
    const dir = sprintDir(root, ID, slug('demo'));
    await fs.mkdir(dir, { recursive: true });
    expect(await resolveSprintDir(root, ID)).toBe(dir);
  });

  it('finds the legacy bare <id>/ dir', async () => {
    const legacy = join(sprintsDir(root), String(ID));
    await fs.mkdir(legacy, { recursive: true });
    expect(await resolveSprintDir(root, ID)).toBe(legacy);
  });

  it('prefers the new dir when both forms exist', async () => {
    const legacy = join(sprintsDir(root), String(ID));
    const slugged = sprintDir(root, ID, slug('demo'));
    await fs.mkdir(legacy, { recursive: true });
    await fs.mkdir(slugged, { recursive: true });
    expect(await resolveSprintDir(root, ID)).toBe(slugged);
  });

  it('returns undefined when neither exists, and ignores a stray non-uuid dir', async () => {
    await fs.mkdir(join(sprintsDir(root), 'not-a-uuid'), { recursive: true });
    expect(await resolveSprintDir(root, ID)).toBeUndefined();
  });
});

describe('resolveMemoryDir (tolerant id-prefix resolver)', () => {
  let root: AbsolutePath;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = tmp.root;
    cleanup = tmp.cleanup;
    await fs.mkdir(String(root), { recursive: true });
  });
  afterEach(async () => cleanup());

  it('finds both the legacy bare and new slugged memory dirs, preferring the new', async () => {
    const id = 'proj-1';
    const legacy = join(String(root), id);
    const slugged = join(String(root), buildSluggedName(id, 'demo'));
    await fs.mkdir(legacy, { recursive: true });
    expect(await resolveMemoryDir(root, id)).toBe(legacy);
    await fs.mkdir(slugged, { recursive: true });
    expect(await resolveMemoryDir(root, id)).toBe(slugged);
  });
});
