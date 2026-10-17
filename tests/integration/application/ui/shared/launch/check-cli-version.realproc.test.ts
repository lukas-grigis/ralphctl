import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';

const posix = process.platform !== 'win32';
const originalPath = process.env['PATH'];

afterEach(() => {
  process.env['PATH'] = originalPath;
});

// Fake `opencode` on PATH, no injected seams: the production probe must run and read its version.
const withFakeOpencode = async (version: string): Promise<void> => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'ralphctl-opencode-version-'));
  await fs.writeFile(join(dir, 'opencode'), `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  process.env['PATH'] = `${dir}${delimiter}${originalPath ?? ''}`;
};

const refineOnOpencode: Settings = {
  ...DEFAULT_SETTINGS,
  ai: { ...DEFAULT_SETTINGS.ai, refine: defaultAiSettingsForProvider('opencode').refine },
};

describe.skipIf(!posix)('checkCli — real OpenCode version probe', () => {
  it('fails the launch when the opencode on PATH is 2.x', async () => {
    await withFakeOpencode('2.0.1');
    const result = await checkCli('refine', refineOnOpencode);
    expect(result?.ok).toBe(false);
    if (result === undefined || result.ok) return;
    expect(result.reason).toContain('opencode 2.0.1');
  });

  it('lets a 1.x opencode through', async () => {
    await withFakeOpencode('1.18.35');
    expect(await checkCli('refine', refineOnOpencode)).toBeUndefined();
  });
});
