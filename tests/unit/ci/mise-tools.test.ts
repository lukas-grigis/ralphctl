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
  });

  // `engines.pnpm` is the LOCKFILE floor, not the contributor pin (that is mise.toml's `pnpm = "12"`).
  // Dependabot's updater reads this field to pick its pnpm and runs an 11.x (11.17 on 2026-09-13,
  // 11.25 once dependabot-core #16169 rolls out); `>=12` made every weekly run fail with
  // tool_version_not_supported and no PR. A pnpm-11-written lockfile round-trips through pnpm 12
  // `--frozen-lockfile` unchanged (probed 2026-09-16), so 11 is the honest floor.
  it('engines.pnpm admits the pnpm 11 line Dependabot runs on', () => {
    const pkg = JSON.parse(read('package.json')) as { engines?: { pnpm?: string } };
    expect(pkg.engines?.pnpm).toBe('>=11');
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
