import { describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { abs } from '@src/application/_test-fakes/fixtures.ts';
import { linkSkillsLeaf, type LinkSkillsCtx, type SessionSkillsLinkerLike, type SkillsPhase } from './link-skills.ts';

class RecordingLinker implements SessionSkillsLinkerLike {
  readonly installCalls: { readonly cwd: AbsolutePath; readonly phase: SkillsPhase }[] = [];
  readonly uninstallCalls: AbsolutePath[] = [];

  install(sessionDir: AbsolutePath, phase: SkillsPhase): Promise<Result<void, StorageError>> {
    this.installCalls.push({ cwd: sessionDir, phase });
    return Promise.resolve(Result.ok());
  }
  uninstall(sessionDir: AbsolutePath): Promise<Result<void, StorageError>> {
    this.uninstallCalls.push(sessionDir);
    return Promise.resolve(Result.ok());
  }
}

describe('linkSkillsLeaf', () => {
  it('forwards the cwd and phase to the linker on install', async () => {
    const linker = new RecordingLinker();
    const leaf = linkSkillsLeaf<LinkSkillsCtx>({ skillsLinker: linker }, { phase: 'refine' });

    const cwd = abs('/tmp/session-1');
    const result = await leaf.execute({ cwd });

    expect(result.ok).toBe(true);
    expect(linker.installCalls).toStrictEqual([{ cwd, phase: 'refine' }]);
    expect(linker.uninstallCalls).toHaveLength(0);
  });

  it('passes the exec phase through unchanged', async () => {
    const linker = new RecordingLinker();
    const leaf = linkSkillsLeaf<LinkSkillsCtx>({ skillsLinker: linker }, { phase: 'exec' });
    const cwd = abs('/tmp/session-2');
    const result = await leaf.execute({ cwd });
    expect(result.ok).toBe(true);
    expect(linker.installCalls).toStrictEqual([{ cwd, phase: 'exec' }]);
  });
});
