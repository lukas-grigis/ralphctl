import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundledAgentDefinitionSource, resolveBundledRoot } from '@src/integration/ai/agents/bundled/source.ts';
import { BUNDLED_AGENT_DEFINITIONS } from '@src/integration/ai/agents/_engine/registry.ts';

describe('resolveBundledRoot', () => {
  it('resolves the co-located agent-definitions/ dir when the build copied .md files beside the bundle', () => {
    const beside = (p: string): boolean => p === '/pkg/dist/agent-definitions';
    expect(resolveBundledRoot('file:///pkg/dist/cli-CKPJ5SY4.mjs', beside)).toBe('/pkg/dist/agent-definitions');
    expect(resolveBundledRoot('file:///pkg/dist/cli.mjs', beside)).toBe('/pkg/dist/agent-definitions');
  });

  it('resolves the module dir itself in dev, where nothing sits beside source.ts', () => {
    const never = (): boolean => false;
    expect(resolveBundledRoot('file:///pkg/src/integration/ai/agents/bundled/source.ts', never)).toBe(
      '/pkg/src/integration/ai/agents/bundled'
    );
  });
});

describe('createBundledAgentDefinitionSource (production root)', () => {
  const source = createBundledAgentDefinitionSource();

  it('lists exactly the registry defaults', async () => {
    const result = await source.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((d) => d.name).sort()).toEqual([...BUNDLED_AGENT_DEFINITIONS].sort());
  });

  it('reads name + description from frontmatter and a non-trivial body', async () => {
    const result = await source.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evaluator = result.value.find((d) => d.name === 'ralphctl-evaluator');
    expect(evaluator?.description.length).toBeGreaterThan(0);
    expect(evaluator?.content.length).toBeGreaterThan(0);
    const generator = result.value.find((d) => d.name === 'ralphctl-generator');
    expect(generator?.description.length).toBeGreaterThan(0);
    expect(generator?.content.length).toBeGreaterThan(0);
  });

  it('getByName resolves a known bundled definition by its exact file name', async () => {
    const result = await source.getByName('ralphctl-evaluator');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.name).toBe('ralphctl-evaluator');
  });

  it('getByName returns ok(undefined) for an unknown name (not an error)', async () => {
    const result = await source.getByName('ralphctl-does-not-exist');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });
});

describe('createBundledAgentDefinitionSource (custom root)', () => {
  it('errors out cleanly when a registry-referenced file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-agents-'));
    const source = createBundledAgentDefinitionSource({ bundledRoot: root });
    const result = await source.list();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/bundled agent definition not readable/u);
  });

  it('rejects malformed frontmatter with a parse error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-agents-'));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'ralphctl-evaluator.md'), '---\ndescription: only description\n---\n\nbody\n', 'utf-8');
    await writeFile(
      join(root, 'ralphctl-generator.md'),
      '---\nname: ralphctl-generator\ndescription: ok\n---\nbody\n',
      'utf-8'
    );
    const source = createBundledAgentDefinitionSource({ bundledRoot: root });
    const result = await source.list();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/invalid frontmatter/u);
  });

  it('getByName surfaces a StorageError when a present file has malformed frontmatter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-agents-'));
    await writeFile(join(root, 'broken.md'), '---\ndescription: only description\n---\n\nbody\n', 'utf-8');
    const source = createBundledAgentDefinitionSource({ bundledRoot: root });
    const result = await source.getByName('broken');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/invalid frontmatter/u);
  });

  it('requires frontmatter name to match the file base name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-agents-'));
    await writeFile(
      join(root, 'ralphctl-evaluator.md'),
      '---\nname: mismatch\ndescription: ok\n---\n\nbody\n',
      'utf-8'
    );
    await writeFile(
      join(root, 'ralphctl-generator.md'),
      '---\nname: ralphctl-generator\ndescription: ok\n---\nbody\n',
      'utf-8'
    );
    const source = createBundledAgentDefinitionSource({ bundledRoot: root });
    const result = await source.list();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/must match source name/u);
  });
});
