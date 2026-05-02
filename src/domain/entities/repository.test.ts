import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { Repository } from './repository.ts';

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('Repository.create', () => {
  it('derives name from basename when not supplied', () => {
    const r = Repository.create({ path: path('/repos/my-tool') });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('my-tool');
  });

  it('uses an explicit name when provided', () => {
    const r = Repository.create({ path: path('/repos/x'), name: 'pretty-name' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('pretty-name');
  });

  it('trims an explicit name', () => {
    const r = Repository.create({ path: path('/repos/x'), name: '  trimmed  ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('trimmed');
  });

  it('rejects an empty name', () => {
    const r = Repository.create({ path: path('/repos/x'), name: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('repository.name');
  });

  it('accepts a check script + trims', () => {
    const r = Repository.create({ path: path('/repos/x'), checkScript: '  pnpm test  ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.checkScript).toBe('pnpm test');
  });

  it('rejects empty check script', () => {
    const r = Repository.create({ path: path('/repos/x'), checkScript: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('repository.checkScript');
  });

  it('accepts a positive integer timeout', () => {
    const r = Repository.create({ path: path('/repos/x'), checkTimeout: 60000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.checkTimeout).toBe(60000);
  });

  it('rejects zero or negative timeout', () => {
    expect(Repository.create({ path: path('/repos/x'), checkTimeout: 0 }).ok).toBe(false);
    expect(Repository.create({ path: path('/repos/x'), checkTimeout: -1 }).ok).toBe(false);
  });

  it('rejects fractional timeout', () => {
    const r = Repository.create({ path: path('/repos/x'), checkTimeout: 1.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('repository.checkTimeout');
  });
});

describe('Repository.withCheckScript', () => {
  it('returns a new instance with the new script', () => {
    const r0 = Repository.create({ path: path('/repos/x') });
    if (!r0.ok) throw new Error('precondition failed');
    const r1 = r0.value.withCheckScript('pnpm test');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.checkScript).toBe('pnpm test');
    expect(r1.value).not.toBe(r0.value);
    // immutability
    expect(r0.value.checkScript).toBeUndefined();
  });

  it('clears the script when undefined is passed', () => {
    const r0 = Repository.create({ path: path('/repos/x'), checkScript: 'pnpm test' });
    if (!r0.ok) throw new Error('precondition failed');
    const r1 = r0.value.withCheckScript(undefined);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.checkScript).toBeUndefined();
  });

  it('rejects empty script', () => {
    const r0 = Repository.create({ path: path('/repos/x') });
    if (!r0.ok) throw new Error('precondition failed');
    expect(r0.value.withCheckScript('   ').ok).toBe(false);
  });
});

describe('Repository.withCheckTimeout', () => {
  it('returns a new instance with the new timeout', () => {
    const r0 = Repository.create({ path: path('/repos/x') });
    if (!r0.ok) throw new Error('precondition failed');
    const r1 = r0.value.withCheckTimeout(120_000);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.checkTimeout).toBe(120_000);
  });

  it('rejects invalid timeout', () => {
    const r0 = Repository.create({ path: path('/repos/x') });
    if (!r0.ok) throw new Error('precondition failed');
    expect(r0.value.withCheckTimeout(0).ok).toBe(false);
  });
});

describe('Repository.setupScript', () => {
  it('accepts a setup script + trims', () => {
    const r = Repository.create({ path: path('/repos/x'), setupScript: '  pnpm install  ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.setupScript).toBe('pnpm install');
  });

  it('defaults to undefined when omitted', () => {
    const r = Repository.create({ path: path('/repos/x') });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.setupScript).toBeUndefined();
  });

  it('rejects empty setup script', () => {
    const r = Repository.create({ path: path('/repos/x'), setupScript: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('repository.setupScript');
  });
});

describe('Repository.withSetupScript', () => {
  it('returns a new instance with the new script', () => {
    const r0 = Repository.create({ path: path('/repos/x') });
    if (!r0.ok) throw new Error('precondition failed');
    const r1 = r0.value.withSetupScript('pnpm install');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.setupScript).toBe('pnpm install');
    expect(r1.value).not.toBe(r0.value);
    // immutability
    expect(r0.value.setupScript).toBeUndefined();
  });

  it('clears the script when undefined is passed', () => {
    const r0 = Repository.create({ path: path('/repos/x'), setupScript: 'pnpm install' });
    if (!r0.ok) throw new Error('precondition failed');
    const r1 = r0.value.withSetupScript(undefined);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.setupScript).toBeUndefined();
  });

  it('rejects empty script', () => {
    const r0 = Repository.create({ path: path('/repos/x') });
    if (!r0.ok) throw new Error('precondition failed');
    expect(r0.value.withSetupScript('   ').ok).toBe(false);
  });

  it('preserves checkScript and checkTimeout when updating setupScript', () => {
    const r0 = Repository.create({
      path: path('/repos/x'),
      checkScript: 'pnpm test',
      checkTimeout: 60_000,
    });
    if (!r0.ok) throw new Error('precondition failed');
    const r1 = r0.value.withSetupScript('pnpm install');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.checkScript).toBe('pnpm test');
    expect(r1.value.checkTimeout).toBe(60_000);
  });
});

describe('Repository.onboardedAt', () => {
  const TS = IsoTimestamp.trustString('2026-04-29T12:00:00.000Z');

  it('defaults to null when omitted', () => {
    const r = Repository.create({ path: path('/repos/x') });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.onboardedAt).toBeNull();
  });

  it('accepts an explicit onboardedAt timestamp at construction', () => {
    const r = Repository.create({ path: path('/repos/x'), onboardedAt: TS });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.onboardedAt).toBe(TS);
  });

  it('markOnboarded returns a new instance with the timestamp set', () => {
    const r0 = Repository.create({ path: path('/repos/x') });
    if (!r0.ok) throw new Error('precondition failed');
    const r1 = r0.value.markOnboarded(TS);
    expect(r1).not.toBe(r0.value);
    expect(r1.onboardedAt).toBe(TS);
    // Original is untouched (immutability).
    expect(r0.value.onboardedAt).toBeNull();
  });

  it('markOnboarded preserves all other fields', () => {
    const r0 = Repository.create({
      path: path('/repos/x'),
      name: 'pretty',
      checkScript: 'pnpm test',
      checkTimeout: 60_000,
      setupScript: 'pnpm install',
    });
    if (!r0.ok) throw new Error('precondition failed');
    const r1 = r0.value.markOnboarded(TS);
    expect(r1.name).toBe('pretty');
    expect(r1.checkScript).toBe('pnpm test');
    expect(r1.checkTimeout).toBe(60_000);
    expect(r1.setupScript).toBe('pnpm install');
  });

  it('markOnboarded overwrites a prior timestamp (most-recent run wins)', () => {
    const earlier = IsoTimestamp.trustString('2026-01-01T00:00:00.000Z');
    const r0 = Repository.create({ path: path('/repos/x'), onboardedAt: earlier });
    if (!r0.ok) throw new Error('precondition failed');
    const r1 = r0.value.markOnboarded(TS);
    expect(r1.onboardedAt).toBe(TS);
  });

  it('clearOnboarded returns a new instance with onboardedAt cleared', () => {
    const r0 = Repository.create({ path: path('/repos/x'), onboardedAt: TS });
    if (!r0.ok) throw new Error('precondition failed');
    const r1 = r0.value.clearOnboarded();
    expect(r1.onboardedAt).toBeNull();
    expect(r0.value.onboardedAt).toBe(TS);
  });
});
