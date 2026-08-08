import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultInteractiveSpawn } from '@src/integration/ai/providers/_engine/interactive-spawn.ts';

// Spawns a real `node` child, because the property under test is what the OS-level environment
// looks like from inside that child — a fake spawn could only re-assert the code's own spread.

const tempDirs: string[] = [];
const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ralphctl-spawn-env-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

const runNode = async (script: string, env?: Readonly<Record<string, string>>): Promise<number | null> => {
  const child = defaultInteractiveSpawn(process.execPath, ['-e', script], {
    stdio: 'inherit',
    cwd: process.cwd(),
    ...(env !== undefined ? { env } : {}),
  });
  return new Promise((resolve) => child.on('close', resolve));
};

describe('defaultInteractiveSpawn', () => {
  it('layers the supplied env over the parent environment instead of replacing it', async () => {
    // A bare `env` override would strip PATH / HOME and every provider credential variable from
    // the child — the CLI would start without its own auth. OPENCODE_CONFIG_CONTENT has to arrive
    // as an addition, not a substitution.
    const dir = await makeTempDir();
    const out = join(dir, 'env.json');
    const code = await runNode(
      `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ injected: process.env.RALPHCTL_TEST_INJECTED, path: process.env.PATH }))`,
      { RALPHCTL_TEST_INJECTED: 'yes' }
    );

    expect(code).toBe(0);
    const seen = JSON.parse(await readFile(out, 'utf8')) as { injected?: string; path?: string };
    expect(seen.injected).toBe('yes');
    expect(seen.path).toBe(process.env['PATH']);
  });

  it('leaves the environment untouched when no override is supplied', async () => {
    const dir = await makeTempDir();
    const out = join(dir, 'env.json');
    const code = await runNode(
      `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ injected: process.env.RALPHCTL_TEST_INJECTED ?? null }))`
    );

    expect(code).toBe(0);
    const seen = JSON.parse(await readFile(out, 'utf8')) as { injected: string | null };
    expect(seen.injected).toBeNull();
  });
});
