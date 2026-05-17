import { describe, expect, it } from 'vitest';
import { generateBranchName, isValidBranchName } from '@src/integration/io/branch-name.ts';

describe('generateBranchName', () => {
  it('prefixes the sprint id with ralphctl/', () => {
    expect(generateBranchName('abc123')).toBe('ralphctl/abc123');
  });

  it('passes the canonical shape through isValidBranchName', () => {
    expect(isValidBranchName(generateBranchName('01928f64-7e9d-7c5d-9c11-cafef00d'))).toBe(true);
  });
});

describe('isValidBranchName', () => {
  it('accepts plain alphanumerics, slashes, hyphens, underscores, dots', () => {
    expect(isValidBranchName('feature/x_1.0-rc')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidBranchName('')).toBe(false);
  });

  it('rejects strings longer than 250 chars', () => {
    expect(isValidBranchName('a'.repeat(251))).toBe(false);
  });

  it('rejects characters outside the conservative regex', () => {
    expect(isValidBranchName('has space')).toBe(false);
    expect(isValidBranchName('has~tilde')).toBe(false);
    expect(isValidBranchName('has?qmark')).toBe(false);
  });

  it('rejects forbidden git ref patterns', () => {
    expect(isValidBranchName('a..b')).toBe(false);
    expect(isValidBranchName('trailing.')).toBe(false);
    expect(isValidBranchName('trailing/')).toBe(false);
    expect(isValidBranchName('locky.lock')).toBe(false);
    expect(isValidBranchName('-leading-hyphen')).toBe(false);
    expect(isValidBranchName('double//slash')).toBe(false);
  });
});
