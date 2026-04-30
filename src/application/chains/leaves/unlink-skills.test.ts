import { describe, expect, it } from 'vitest';

import { Result } from '../../../domain/result.ts';
import type { StorageError } from '../../../domain/errors/storage-error.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { abs } from '../../_test-fakes/fixtures.ts';
import { type LinkSkillsCtx, type SessionSkillsLinkerLike } from './link-skills.ts';
import { unlinkSkillsLeaf } from './unlink-skills.ts';

class RecordingLinker implements SessionSkillsLinkerLike {
  readonly unlinkCalls: AbsolutePath[] = [];

  link(): Promise<Result<void, StorageError>> {
    return Promise.resolve(Result.ok());
  }
  unlink(sessionDir: AbsolutePath): Promise<Result<void, StorageError>> {
    this.unlinkCalls.push(sessionDir);
    return Promise.resolve(Result.ok());
  }
}

describe('unlinkSkillsLeaf', () => {
  it('forwards the cwd to the linker.unlink call', async () => {
    const linker = new RecordingLinker();
    const leaf = unlinkSkillsLeaf<LinkSkillsCtx>({ skillsLinker: linker });

    const cwd = abs('/tmp/session-1');
    const result = await leaf.execute({ cwd });

    expect(result.ok).toBe(true);
    expect(linker.unlinkCalls).toEqual([cwd]);
  });
});
