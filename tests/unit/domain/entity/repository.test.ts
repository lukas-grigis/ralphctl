import { describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import {
  createRepository,
  normalizeVerifyGates,
  setRepositoryVerifyGates,
  type Repository,
  type VerifyGate,
} from '@src/domain/entity/repository.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

const PATH = absolutePath('/tmp/repo');

const mustCreate = (gates?: readonly VerifyGate[]): Repository => {
  const r = createRepository({ path: PATH, name: 'svc', ...(gates !== undefined ? { verifyGates: gates } : {}) });
  if (!r.ok) throw new Error(`expected ok: ${r.error.message}`);
  return r.value;
};

describe('createRepository — verifyGates normalisation', () => {
  it('omits the field entirely when no gates supplied', () => {
    expect(mustCreate().verifyGates).toBeUndefined();
  });

  it('persists structured gates verbatim (trimmed commands, optional timeoutMs)', () => {
    const repo = mustCreate([
      { pathPrefix: 'apps/web-ui', command: '  pnpm --filter web test  ', timeoutMs: 60_000 },
      { pathPrefix: '', command: 'pnpm lint' },
    ]);
    expect(repo.verifyGates).toEqual([
      { pathPrefix: 'apps/web-ui', command: 'pnpm --filter web test', timeoutMs: 60_000 },
      { pathPrefix: '', command: 'pnpm lint' },
    ]);
  });

  it('stores a prefix without a leading "./" or "/" so it reads like a git path', () => {
    const repo = mustCreate([
      { pathPrefix: './apps/api', command: 'go test ./...' },
      { pathPrefix: '/apps/web', command: 'pnpm test' },
      { pathPrefix: './', command: 'pnpm lint' },
      { pathPrefix: ' apps/x', command: 'make' },
    ]);
    expect(repo.verifyGates?.map((g) => g.pathPrefix)).toEqual(['apps/api', 'apps/web', '', ' apps/x']);
  });

  it('drops gates with a blank command and omits the field when none survive', () => {
    expect(mustCreate([{ pathPrefix: 'a', command: '   ' }]).verifyGates).toBeUndefined();
  });

  it('rejects a non-positive per-gate timeoutMs', () => {
    const r = createRepository({
      path: PATH,
      name: 'svc',
      verifyGates: [{ pathPrefix: 'a', command: 'go test ./...', timeoutMs: 0 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });
});

describe('setRepositoryVerifyGates', () => {
  it('replaces the gates, dropping blank-command entries', () => {
    const repo = mustCreate();
    const updated = setRepositoryVerifyGates(repo, [
      { pathPrefix: 'apps/api', command: 'go test ./...' },
      { pathPrefix: 'apps/web', command: '' },
    ]);
    if (!updated.ok) throw new Error(`expected ok: ${updated.error.message}`);
    expect(updated.value.verifyGates).toEqual([{ pathPrefix: 'apps/api', command: 'go test ./...' }]);
  });

  it('clears the field on an empty / all-blank input (no empty array persisted)', () => {
    const repo = mustCreate([{ pathPrefix: 'a', command: 'pnpm test' }]);
    const cleared = setRepositoryVerifyGates(repo, []);
    if (!cleared.ok) throw new Error(`expected ok: ${cleared.error.message}`);
    expect(cleared.value).not.toHaveProperty('verifyGates');
  });

  it('clears the field on undefined', () => {
    const repo = mustCreate([{ pathPrefix: 'a', command: 'pnpm test' }]);
    const cleared = setRepositoryVerifyGates(repo, undefined);
    if (!cleared.ok) throw new Error(`expected ok: ${cleared.error.message}`);
    expect(cleared.value).not.toHaveProperty('verifyGates');
  });
});

describe('normalizeVerifyGates — legacy ⇄ structured precedence', () => {
  it('structured gates win when present and non-empty', () => {
    const gates: readonly VerifyGate[] = [{ pathPrefix: 'apps/web', command: 'pnpm --filter web test' }];
    expect(normalizeVerifyGates('pnpm test', gates)).toBe(gates);
  });

  it('legacy script becomes a single catch-all gate when no gates configured', () => {
    expect(normalizeVerifyGates('pnpm test', undefined)).toEqual([{ pathPrefix: '', command: 'pnpm test' }]);
  });

  it('empty gate list falls back to the legacy script', () => {
    expect(normalizeVerifyGates('pnpm test', [])).toEqual([{ pathPrefix: '', command: 'pnpm test' }]);
  });

  it('whitespace-only / absent script with no gates → empty list (skipped run)', () => {
    expect(normalizeVerifyGates('   ', undefined)).toEqual([]);
    expect(normalizeVerifyGates(undefined, undefined)).toEqual([]);
    expect(normalizeVerifyGates(undefined, [])).toEqual([]);
  });
});
