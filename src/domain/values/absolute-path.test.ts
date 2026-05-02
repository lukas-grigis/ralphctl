import { describe, expect, it } from 'vitest';

import { AbsolutePath } from './absolute-path.ts';

describe('AbsolutePath', () => {
  it('accepts a unix-style absolute path', () => {
    const r = AbsolutePath.parse('/home/lukas/code');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('/home/lukas/code');
  });

  it('accepts root', () => {
    const r = AbsolutePath.parse('/');
    expect(r.ok).toBe(true);
  });

  it('rejects relative paths', () => {
    const r = AbsolutePath.parse('./foo');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('absolute-path');
      expect(r.error.value).toBe('./foo');
    }
  });

  it('rejects bare relative names', () => {
    const r = AbsolutePath.parse('foo/bar');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('absolute-path');
  });

  it('rejects parent-relative paths', () => {
    const r = AbsolutePath.parse('../foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.value).toBe('../foo');
  });

  it('rejects tilde home prefix', () => {
    const r = AbsolutePath.parse('~/code');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('absolute-path');
      expect(r.error.value).toBe('~/code');
    }
  });

  it('rejects tilde anywhere in the path', () => {
    const r = AbsolutePath.parse('/home/~user/code');
    expect(r.ok).toBe(false);
  });

  it('rejects $VAR style environment references', () => {
    const r = AbsolutePath.parse('/home/$USER/code');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('absolute-path');
      expect(r.error.value).toBe('/home/$USER/code');
    }
  });

  it('rejects ${VAR} style environment references', () => {
    const r = AbsolutePath.parse('/home/${USER}/code');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.value).toBe('/home/${USER}/code');
  });

  it('rejects empty string', () => {
    const r = AbsolutePath.parse('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('absolute-path');
  });

  it('rejects whitespace-only string', () => {
    const r = AbsolutePath.parse('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.value).toBe('   ');
  });

  it('rejects non-string input', () => {
    const r = AbsolutePath.parse(42);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('absolute-path');
      expect(r.error.value).toBe(42);
    }
  });

  it('trustString returns the input typed as an AbsolutePath', () => {
    const p: AbsolutePath = AbsolutePath.trustString('/already/validated');
    expect(p).toBe('/already/validated');
  });
});
