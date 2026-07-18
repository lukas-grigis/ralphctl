import { describe, expect, it, vi } from 'vitest';
import type * as RegistryModule from '@src/integration/ai/skills/_engine/registry.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

// Empty catalog is unreachable through a real bundled build (BUNDLED_SKILLS always ships at
// least one row) — mock the registry to exercise the CLI's empty-state branch the same way a
// downstream build stripped of every skill would hit it.
vi.mock('@src/integration/ai/skills/_engine/registry.ts', async () => {
  const actual = await vi.importActual<typeof RegistryModule>('@src/integration/ai/skills/_engine/registry.ts');
  return { ...actual, BUNDLED_SKILLS: [] };
});

describe('ralphctl skills list — empty catalog', () => {
  it('renders the empty-state line when no skills are bundled and none are dropped in manually', async () => {
    const cli: CliHome = await createCliHome();
    try {
      const result = await runCliCaptured(cli, ['skills', 'list']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('(no skills bundled)');
    } finally {
      await cli.cleanup();
    }
  });
});
