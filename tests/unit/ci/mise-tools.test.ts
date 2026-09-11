import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');

describe('mise is the only tool pin', () => {
  it('mise.toml keeps pnpm on the 12 major — no patch pin', () => {
    expect(read('mise.toml')).toMatch(/^pnpm = "12"$/m);
    expect(read('mise.toml')).not.toMatch(/pnpm = "12\.\d/);
  });

  it('package.json has no packageManager field — that pin fights mise and Corepack/self-switch', () => {
    const pkg = JSON.parse(read('package.json')) as { packageManager?: string; engines?: { pnpm?: string } };
    expect(pkg.packageManager).toBeUndefined();
    expect(pkg.engines?.pnpm).toBe('>=12');
  });

  it('CI and release install Node and pnpm via mise-action, not pnpm/action-setup', () => {
    const ci = read('.github/workflows/ci.yml');
    const release = read('.github/workflows/release.yml');
    expect(ci).toContain('jdx/mise-action@v4');
    expect(release).toContain('jdx/mise-action@v4');
    expect(ci).not.toContain('pnpm/action-setup');
    expect(release).not.toContain('pnpm/action-setup');
  });
});
