import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AgentDefinition, RenderedAgentFile } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { createFilesystemAgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/filesystem-agent-definition-adapter.ts';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'fs-agent-defs-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const definition = (name: string, content: string): AgentDefinition => ({
  name,
  description: `desc for ${name}`,
  content,
});

/** Trivial test-only renderer: `<parentDir>/agents/ralphctl-<name>.txt`, raw content. */
const testRenderer = (def: AgentDefinition): Result<RenderedAgentFile, StorageError> =>
  Result.ok({
    relPath: join('.test-provider', 'agents', `ralphctl-${def.name}.txt`),
    content: def.content,
  });

const makeAdapter = () =>
  createFilesystemAgentDefinitionAdapter({
    providerId: 'test-provider',
    parentDir: '.test-provider',
    renderer: testRenderer,
    convention: 'agents live under .test-provider/agents/',
  });

describe('createFilesystemAgentDefinitionAdapter — install / uninstall', () => {
  it('writes each definition via the renderer relPath', async () => {
    const session = await makeSession();
    const adapter = makeAdapter();

    const result = await adapter.install(session, [definition('alpha', 'A body'), definition('beta', 'B body')]);
    expect(result.ok).toBe(true);

    expect(await readFile(join(String(session), '.test-provider/agents/ralphctl-alpha.txt'), 'utf-8')).toBe('A body');
    expect(await readFile(join(String(session), '.test-provider/agents/ralphctl-beta.txt'), 'utf-8')).toBe('B body');
  });

  it('project-wins: preserves a pre-existing file at the rendered destination', async () => {
    const session = await makeSession();
    const projectFile = join(String(session), '.test-provider/agents/ralphctl-alpha.txt');
    await mkdir(join(String(session), '.test-provider/agents'), { recursive: true });
    await writeFile(projectFile, 'PROJECT VERSION', 'utf-8');

    const adapter = makeAdapter();
    const result = await adapter.install(session, [definition('alpha', 'bundled body')]);
    expect(result.ok).toBe(true);

    expect(await readFile(projectFile, 'utf-8')).toBe('PROJECT VERSION');
  });

  it('install is idempotent — second call does not rewrite an already-installed file', async () => {
    const session = await makeSession();
    const adapter = makeAdapter();
    await adapter.install(session, [definition('alpha', 'v1')]);
    const initialMtime = (await stat(join(String(session), '.test-provider/agents/ralphctl-alpha.txt'))).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await adapter.install(session, [definition('alpha', 'v2 should not overwrite')]);
    const secondMtime = (await stat(join(String(session), '.test-provider/agents/ralphctl-alpha.txt'))).mtimeMs;
    expect(secondMtime).toBe(initialMtime);
  });

  it('uninstall removes only the definitions install created and leaves pre-existing project files untouched', async () => {
    const session = await makeSession();
    const projectFile = join(String(session), '.test-provider/agents/ralphctl-project-owned.txt');
    await mkdir(join(String(session), '.test-provider/agents'), { recursive: true });
    await writeFile(projectFile, 'PROJECT', 'utf-8');

    const adapter = makeAdapter();
    await adapter.install(session, [definition('project-owned', 'bundled'), definition('alpha', 'A body')]);

    const uninstall = await adapter.uninstall(session);
    expect(uninstall.ok).toBe(true);

    // Pre-existing project file survives.
    expect(await readFile(projectFile, 'utf-8')).toBe('PROJECT');
    // The file this adapter actually wrote is gone.
    expect(existsSync(join(String(session), '.test-provider/agents/ralphctl-alpha.txt'))).toBe(false);
  });

  it('uninstall is a no-op when nothing was installed', async () => {
    const session = await makeSession();
    const adapter = makeAdapter();
    const result = await adapter.uninstall(session);
    expect(result.ok).toBe(true);
  });

  it('uninstall tidies empty parent <parentDir>/agents and <parentDir> dirs', async () => {
    const session = await makeSession();
    const adapter = makeAdapter();
    await adapter.install(session, [definition('alpha', 'A body')]);
    await adapter.uninstall(session);
    expect(existsSync(join(String(session), '.test-provider'))).toBe(false);
  });

  it('preserves a non-empty parentDir when other content lives there', async () => {
    const session = await makeSession();
    await mkdir(join(String(session), '.test-provider'), { recursive: true });
    await writeFile(join(String(session), '.test-provider/OTHER.txt'), '# other project file', 'utf-8');

    const adapter = makeAdapter();
    await adapter.install(session, [definition('alpha', 'A body')]);
    await adapter.uninstall(session);

    expect(existsSync(join(String(session), '.test-provider/agents'))).toBe(false);
    expect(existsSync(join(String(session), '.test-provider/OTHER.txt'))).toBe(true);
  });
});

describe('createFilesystemAgentDefinitionAdapter — .git/info/exclude wildcard', () => {
  it('appends the <parentDir>/agents/ralphctl-* line on first install', async () => {
    const session = await makeSession();
    await mkdir(join(String(session), '.git/info'), { recursive: true });
    await writeFile(join(String(session), '.git/info/exclude'), '# default\n', 'utf-8');

    const adapter = makeAdapter();
    await adapter.install(session, [definition('alpha', 'A body')]);

    const content = await readFile(join(String(session), '.git/info/exclude'), 'utf-8');
    expect(content).toContain('.test-provider/agents/ralphctl-*');
  });

  it('does not duplicate the wildcard on repeated installs', async () => {
    const session = await makeSession();
    await mkdir(join(String(session), '.git/info'), { recursive: true });
    await writeFile(join(String(session), '.git/info/exclude'), '', 'utf-8');

    const adapter = makeAdapter();
    await adapter.install(session, [definition('alpha', 'A body')]);
    await adapter.install(session, [definition('beta', 'B body')]);

    const content = await readFile(join(String(session), '.git/info/exclude'), 'utf-8');
    const matches = content.split('\n').filter((l) => l.trim() === '.test-provider/agents/ralphctl-*');
    expect(matches).toHaveLength(1);
  });

  it('install proceeds when .git is missing (non-git working tree)', async () => {
    const session = await makeSession();
    const adapter = makeAdapter();
    const result = await adapter.install(session, [definition('alpha', 'A body')]);
    expect(result.ok).toBe(true);
    expect(existsSync(join(String(session), '.git'))).toBe(false);
  });
});

describe('createFilesystemAgentDefinitionAdapter — renderer errors', () => {
  it('propagates a renderer error and writes no file for the rejected definition', async () => {
    const session = await makeSession();
    const failingRenderer = (def: AgentDefinition): Result<RenderedAgentFile, StorageError> =>
      def.name === 'bad'
        ? Result.error({ subCode: 'schema-mismatch', message: 'too big', name: 'StorageError' } as StorageError)
        : testRenderer(def);
    const adapter = createFilesystemAgentDefinitionAdapter({
      providerId: 'test-provider',
      parentDir: '.test-provider',
      renderer: failingRenderer,
      convention: 'agents live under .test-provider/agents/',
    });

    const result = await adapter.install(session, [definition('alpha', 'A body'), definition('bad', 'too long')]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('too big');

    // The definition before the failing one was still written.
    expect(existsSync(join(String(session), '.test-provider/agents/ralphctl-alpha.txt'))).toBe(true);
    expect(existsSync(join(String(session), '.test-provider/agents/ralphctl-bad.txt'))).toBe(false);
  });
});
