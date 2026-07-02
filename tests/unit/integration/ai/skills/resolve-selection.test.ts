/**
 * Unit cover for the single skill-selection resolution seam,
 * `createResolvedSkillSource` (`src/integration/ai/skills/_engine/resolve-selection.ts`).
 *
 * The decorator is pure over an injected inner {@link SkillSource}, so every case builds a fake
 * inner inline — no filesystem, no launcher. Cases fence the four documented behaviours:
 *   1. dedupe by name keeping the LAST occurrence (phase folder beats bundled);
 *   2. subtraction of the per-flow disabled name-set;
 *   3. `getByName` passes through UNFILTERED (opt-out governs auto-install, not name resolution);
 *   4. empty inputs / error propagation.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { FlowId } from '@src/integration/ai/skills/_engine/registry.ts';
import { createResolvedSkillSource } from '@src/integration/ai/skills/_engine/resolve-selection.ts';

const skill = (name: string, marker = name): Skill => ({
  name,
  description: `desc for ${name}`,
  // `marker` lets a test tell two same-named skills apart so it can assert WHICH one survived dedupe.
  content: `# ${name}\n\n${marker}`,
});

/** Inner fake whose `getForFlow` returns a fixed list and whose `getByName` scans that same list. */
const fixedInner = (forFlow: readonly Skill[]): SkillSource => ({
  async getForFlow() {
    return Result.ok(forFlow);
  },
  async getByName(name: string) {
    return Result.ok(forFlow.find((s) => s.name === name));
  },
});

const names = (r: Result<readonly Skill[], StorageError>): readonly string[] => {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error.message}`);
  return r.value.map((s) => s.name);
};

describe('createResolvedSkillSource — dedupe (last occurrence wins)', () => {
  it('keeps the LAST occurrence of a duplicated name at its last position', async () => {
    const inner = fixedInner([
      skill('ralphctl-foo', 'bundled'),
      skill('ralphctl-bar', 'bundled'),
      skill('ralphctl-foo', 'phase'), // later source — must win
    ]);
    const source = createResolvedSkillSource({ inner, flowDisabled: () => [] });

    const result = await source.getForFlow('implement');
    expect(names(result)).toEqual(['ralphctl-bar', 'ralphctl-foo']);
    if (!result.ok) throw new Error('unreachable');
    // The surviving `ralphctl-foo` is the phase-folder copy, not the bundled one.
    expect(result.value.find((s) => s.name === 'ralphctl-foo')?.content).toContain('phase');
  });

  it('preserves order and identity byte-for-byte when there are no duplicate names', async () => {
    const list = [skill('ralphctl-a'), skill('ralphctl-b'), skill('ralphctl-c')];
    const inner = fixedInner(list);
    const source = createResolvedSkillSource({ inner, flowDisabled: () => [] });

    const result = await source.getForFlow('refine');
    expect(names(result)).toEqual(['ralphctl-a', 'ralphctl-b', 'ralphctl-c']);
  });
});

describe('createResolvedSkillSource — disabled-name subtraction', () => {
  it('removes disabled names for the flow', async () => {
    const inner = fixedInner([skill('ralphctl-a'), skill('ralphctl-b'), skill('ralphctl-c')]);
    const source = createResolvedSkillSource({ inner, flowDisabled: () => ['ralphctl-b'] });

    const result = await source.getForFlow('implement');
    expect(names(result)).toEqual(['ralphctl-a', 'ralphctl-c']);
  });

  it('subtracts AFTER dedupe — disabling a name drops even the surviving (last) copy', async () => {
    const inner = fixedInner([
      skill('ralphctl-foo', 'bundled'),
      skill('ralphctl-foo', 'phase'),
      skill('ralphctl-keep'),
    ]);
    const source = createResolvedSkillSource({ inner, flowDisabled: () => ['ralphctl-foo'] });

    const result = await source.getForFlow('implement');
    expect(names(result)).toEqual(['ralphctl-keep']);
  });

  it('is passed the getForFlow flowId so a run-scoped closure can key on it', async () => {
    const seen: FlowId[] = [];
    const inner = fixedInner([skill('ralphctl-a')]);
    const source = createResolvedSkillSource({
      inner,
      flowDisabled: (flowId) => {
        seen.push(flowId);
        return flowId === 'plan' ? ['ralphctl-a'] : [];
      },
    });

    expect(names(await source.getForFlow('refine'))).toEqual(['ralphctl-a']);
    expect(names(await source.getForFlow('plan'))).toEqual([]);
    expect(seen).toEqual(['refine', 'plan']);
  });

  it('tolerates duplicate names in the disabled list (collapsed into a set)', async () => {
    const inner = fixedInner([skill('ralphctl-a'), skill('ralphctl-b')]);
    const source = createResolvedSkillSource({
      inner,
      flowDisabled: () => ['ralphctl-a', 'ralphctl-a', 'ralphctl-a'],
    });

    expect(names(await source.getForFlow('implement'))).toEqual(['ralphctl-b']);
  });
});

describe('createResolvedSkillSource — getByName passthrough', () => {
  it('resolves a known name even when it is in the disabled set (opt-out ≠ unknown)', async () => {
    const inner = fixedInner([skill('ralphctl-a'), skill('ralphctl-b')]);
    // Disable everything for getForFlow — getByName must still resolve the name.
    const source = createResolvedSkillSource({ inner, flowDisabled: () => ['ralphctl-a', 'ralphctl-b'] });

    const byName = await source.getByName('ralphctl-a');
    expect(byName.ok).toBe(true);
    if (!byName.ok) throw new Error('unreachable');
    expect(byName.value?.name).toBe('ralphctl-a');

    // And getForFlow still subtracts it — the two seams disagree by design.
    expect(names(await source.getForFlow('implement'))).toEqual([]);
  });

  it('returns undefined for a genuinely unknown name', async () => {
    const inner = fixedInner([skill('ralphctl-a')]);
    const source = createResolvedSkillSource({ inner, flowDisabled: () => [] });

    const byName = await source.getByName('ralphctl-missing');
    expect(byName.ok).toBe(true);
    if (!byName.ok) throw new Error('unreachable');
    expect(byName.value).toBeUndefined();
  });
});

describe('createResolvedSkillSource — empty inputs and error propagation', () => {
  it('returns an empty list for an empty inner source', async () => {
    const source = createResolvedSkillSource({ inner: fixedInner([]), flowDisabled: () => ['ralphctl-x'] });
    expect(names(await source.getForFlow('implement'))).toEqual([]);
  });

  it('propagates a hard read error from getForFlow without swallowing it', async () => {
    const err = new StorageError({ subCode: 'io', message: 'disk gone' });
    const inner: SkillSource = {
      async getForFlow() {
        return Result.error(err);
      },
      async getByName() {
        return Result.ok(undefined);
      },
    };
    const source = createResolvedSkillSource({ inner, flowDisabled: () => [] });

    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe(err);
  });

  it('propagates a hard read error from getByName', async () => {
    const err = new StorageError({ subCode: 'parse', message: 'bad frontmatter' });
    const inner: SkillSource = {
      async getForFlow() {
        return Result.ok([]);
      },
      async getByName() {
        return Result.error(err);
      },
    };
    const source = createResolvedSkillSource({ inner, flowDisabled: () => [] });

    const result = await source.getByName('ralphctl-a');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe(err);
  });
});
