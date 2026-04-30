import { describe, expect, it } from 'vitest';

import { Result } from '../../../domain/result.ts';
import type { StorageError } from '../../../domain/errors/storage-error.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { abs } from '../../_test-fakes/fixtures.ts';
import { linkSkillsLeaf, type LinkSkillsCtx, type SessionSkillsLinkerLike } from './link-skills.ts';

class RecordingLinker implements SessionSkillsLinkerLike {
  readonly linkCalls: { sessionDir: AbsolutePath; skills: readonly string[] }[] = [];
  readonly unlinkCalls: AbsolutePath[] = [];

  link(sessionDir: AbsolutePath, skills: readonly string[]): Promise<Result<void, StorageError>> {
    this.linkCalls.push({ sessionDir, skills });
    return Promise.resolve(Result.ok());
  }
  unlink(sessionDir: AbsolutePath): Promise<Result<void, StorageError>> {
    this.unlinkCalls.push(sessionDir);
    return Promise.resolve(Result.ok());
  }
}

describe('linkSkillsLeaf', () => {
  it('forwards the cwd and configured skill names to the linker', async () => {
    const linker = new RecordingLinker();
    const leaf = linkSkillsLeaf<LinkSkillsCtx>({ skillsLinker: linker }, { skills: ['planner', 'reviewer'] });

    const cwd = abs('/tmp/session-1');
    const result = await leaf.execute({ cwd });

    expect(result.ok).toBe(true);
    expect(linker.linkCalls).toHaveLength(1);
    expect(linker.linkCalls[0]?.sessionDir).toBe(cwd);
    expect(linker.linkCalls[0]?.skills).toEqual(['planner', 'reviewer']);
  });

  it('defaults skills to an empty list when not configured', async () => {
    const linker = new RecordingLinker();
    const leaf = linkSkillsLeaf<LinkSkillsCtx>({ skillsLinker: linker });

    await leaf.execute({ cwd: abs('/tmp/session-1') });

    expect(linker.linkCalls[0]?.skills).toEqual([]);
  });
});
