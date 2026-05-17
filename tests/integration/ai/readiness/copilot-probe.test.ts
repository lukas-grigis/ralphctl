import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copilotProbe } from '@src/integration/ai/readiness/copilot/probe.ts';
import { FIXED_NOW, makeRepository } from '@tests/fixtures/domain.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import { isAbsent, isPresent } from '@src/integration/ai/readiness/_engine/predicates.ts';

const repoAt = (path: string): Repository => makeRepository({ path, name: 'tmp', slug: 'tmp' });

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ralphctl-copilot-probe-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('copilotProbe', () => {
  it('returns absent for an empty repo', async () => {
    const r = await copilotProbe.evaluate(repoAt(dir), FIXED_NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isAbsent(r.value)).toBe(true);
  });

  it('returns present when .github/copilot-instructions.md exists', async () => {
    await fs.mkdir(join(dir, '.github'), { recursive: true });
    await fs.writeFile(join(dir, '.github/copilot-instructions.md'), 'instructions');
    const r = await copilotProbe.evaluate(repoAt(dir), FIXED_NOW);
    expect(r.ok).toBe(true);
    if (!r.ok || !isPresent(r.value) || r.value.artifacts.tool !== 'copilot') throw new Error('expected present');
    expect(r.value.artifacts.copilotInstructions?.path.endsWith('.github/copilot-instructions.md')).toBe(true);
  });
});
