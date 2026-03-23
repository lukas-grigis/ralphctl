import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock homedir to prevent reading the real ~/.claude/settings.json during tests.
// The mocked homedir points to a non-existent directory so no user-level settings
// are loaded, keeping tests hermetic.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => join(actual.tmpdir(), 'ralphctl-fake-home-nonexistent'),
  };
});

import { checkTaskPermissions, getProviderPermissions, isToolAllowed } from './permissions.ts';
import type { ProviderPermissions } from './permissions.ts';

// ---------------------------------------------------------------------------
// isToolAllowed — pure function, no I/O
// ---------------------------------------------------------------------------

describe('isToolAllowed', () => {
  it('returns ask when allow and deny lists are both empty', () => {
    const perms: ProviderPermissions = { allow: [], deny: [] };
    expect(isToolAllowed(perms, 'Bash')).toBe('ask');
  });

  it('returns ask when no pattern matches the tool', () => {
    const perms: ProviderPermissions = { allow: ['Write(*)'], deny: [] };
    expect(isToolAllowed(perms, 'Bash', 'git commit')).toBe('ask');
  });

  describe('allow list', () => {
    it('returns true for exact tool name match', () => {
      const perms: ProviderPermissions = { allow: ['Bash'], deny: [] };
      expect(isToolAllowed(perms, 'Bash')).toBe(true);
    });

    it('does not match different tool name', () => {
      const perms: ProviderPermissions = { allow: ['Write'], deny: [] };
      expect(isToolAllowed(perms, 'Bash')).toBe('ask');
    });

    it('returns true for Bash(*) matching any specifier', () => {
      const perms: ProviderPermissions = { allow: ['Bash(*)'], deny: [] };
      expect(isToolAllowed(perms, 'Bash', 'anything here')).toBe(true);
    });

    it('returns true for Bash(*) even with no specifier', () => {
      const perms: ProviderPermissions = { allow: ['Bash(*)'], deny: [] };
      expect(isToolAllowed(perms, 'Bash')).toBe(true);
    });

    it('returns true for prefix:* pattern matching command', () => {
      const perms: ProviderPermissions = { allow: ['Bash(git commit:*)'], deny: [] };
      expect(isToolAllowed(perms, 'Bash', 'git commit -m "feat: add tests"')).toBe(true);
    });

    it('returns ask for prefix:* pattern when specifier does not match prefix', () => {
      const perms: ProviderPermissions = { allow: ['Bash(git commit:*)'], deny: [] };
      expect(isToolAllowed(perms, 'Bash', 'git push')).toBe('ask');
    });

    it('returns true for simple prefix* pattern matching specifier', () => {
      const perms: ProviderPermissions = { allow: ['Bash(pnpm*)'], deny: [] };
      expect(isToolAllowed(perms, 'Bash', 'pnpm install')).toBe(true);
    });

    it('returns ask for simple prefix* when specifier does not start with prefix', () => {
      const perms: ProviderPermissions = { allow: ['Bash(pnpm*)'], deny: [] };
      expect(isToolAllowed(perms, 'Bash', 'npm install')).toBe('ask');
    });

    it('returns true for exact specifier match', () => {
      const perms: ProviderPermissions = { allow: ['Bash(pnpm test)'], deny: [] };
      expect(isToolAllowed(perms, 'Bash', 'pnpm test')).toBe(true);
    });

    it('returns ask for near-exact specifier that does not match exactly', () => {
      const perms: ProviderPermissions = { allow: ['Bash(pnpm test)'], deny: [] };
      expect(isToolAllowed(perms, 'Bash', 'pnpm test --watch')).toBe('ask');
    });

    it('returns ask when pattern has specifier but call has no specifier', () => {
      const perms: ProviderPermissions = { allow: ['Bash(git commit:*)'], deny: [] };
      expect(isToolAllowed(perms, 'Bash')).toBe('ask');
    });
  });

  describe('deny list', () => {
    it('returns false for pattern matching deny list', () => {
      const perms: ProviderPermissions = { allow: [], deny: ['Bash(rm:*)'] };
      expect(isToolAllowed(perms, 'Bash', 'rm -rf /')).toBe(false);
    });

    it('returns false for Bash(*) in deny list', () => {
      const perms: ProviderPermissions = { allow: [], deny: ['Bash(*)'] };
      expect(isToolAllowed(perms, 'Bash', 'any command')).toBe(false);
    });
  });

  describe('deny takes precedence over allow', () => {
    it('returns false when tool matches both allow and deny', () => {
      const perms: ProviderPermissions = {
        allow: ['Bash(*)'],
        deny: ['Bash(git commit:*)'],
      };
      // git commit matches the deny pattern — deny wins
      expect(isToolAllowed(perms, 'Bash', 'git commit -m "msg"')).toBe(false);
    });

    it('returns true for non-denied specifier when deny does not match', () => {
      const perms: ProviderPermissions = {
        allow: ['Bash(*)'],
        deny: ['Bash(git commit:*)'],
      };
      // git status is NOT in deny, and Bash(*) allows it
      expect(isToolAllowed(perms, 'Bash', 'git status')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// getProviderPermissions — reads settings files from disk
//
// homedir() is mocked to point to a non-existent directory, so user-level
// ~/.claude/settings.json is never read and tests are fully isolated.
// ---------------------------------------------------------------------------

describe('getProviderPermissions', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'ralphctl-perms-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns empty permissions when no settings files exist', () => {
    const result = getProviderPermissions(testDir);
    expect(result).toEqual({ allow: [], deny: [] });
  });

  it('returns empty permissions for copilot provider regardless of settings files', async () => {
    const claudeDir = join(testDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(*)'], deny: [] } })
    );

    const result = getProviderPermissions(testDir, 'copilot');
    expect(result).toEqual({ allow: [], deny: [] });
  });

  it('reads project-level permissions from .claude/settings.local.json', async () => {
    const claudeDir = join(testDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({
        permissions: {
          allow: ['Bash(git commit:*)', 'Bash(pnpm test)'],
          deny: ['Bash(rm:*)'],
        },
      })
    );

    const result = getProviderPermissions(testDir, 'claude');
    expect(result.allow).toEqual(['Bash(git commit:*)', 'Bash(pnpm test)']);
    expect(result.deny).toEqual(['Bash(rm:*)']);
  });

  it('silently ignores malformed project-level settings JSON', async () => {
    const claudeDir = join(testDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, 'settings.local.json'), 'not valid json {{{');

    const result = getProviderPermissions(testDir, 'claude');
    expect(result).toEqual({ allow: [], deny: [] });
  });

  it('handles settings file with no permissions section', async () => {
    const claudeDir = join(testDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, 'settings.local.json'), JSON.stringify({ model: 'claude-3' }));

    const result = getProviderPermissions(testDir, 'claude');
    expect(result).toEqual({ allow: [], deny: [] });
  });

  it('handles settings file with permissions but missing allow/deny keys', async () => {
    const claudeDir = join(testDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ permissions: {} }) // no allow or deny keys
    );

    const result = getProviderPermissions(testDir, 'claude');
    expect(result).toEqual({ allow: [], deny: [] });
  });

  it('defaults to claude behavior when provider is undefined', async () => {
    const claudeDir = join(testDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(pnpm*)'] } })
    );

    // No provider arg — should still read file like claude
    const result = getProviderPermissions(testDir);
    expect(result.allow).toContain('Bash(pnpm*)');
  });
});

// ---------------------------------------------------------------------------
// checkTaskPermissions — integration of getProviderPermissions + isToolAllowed
// ---------------------------------------------------------------------------

describe('checkTaskPermissions', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'ralphctl-chkperms-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns no warnings for copilot provider (all tools granted via --allow-all-tools)', () => {
    const warnings = checkTaskPermissions(testDir, {
      provider: 'copilot',
      needsCommit: true,
      checkScript: 'pnpm test',
    });
    expect(warnings).toEqual([]);
  });

  it('warns about git commit when no settings exist and needsCommit is not false', () => {
    const warnings = checkTaskPermissions(testDir, {});
    const commitWarning = warnings.find((w) => w.specifier === 'git commit');
    expect(commitWarning).toBeDefined();
    expect(commitWarning?.tool).toBe('Bash');
    expect(commitWarning?.message).toContain('Git commits');
  });

  it('does not warn about git commit when needsCommit is false', () => {
    const warnings = checkTaskPermissions(testDir, { needsCommit: false });
    const commitWarning = warnings.find((w) => w.specifier === 'git commit');
    expect(commitWarning).toBeUndefined();
  });

  it('warns about check script when it is not in any approved permissions', () => {
    const warnings = checkTaskPermissions(testDir, {
      checkScript: 'pnpm typecheck && pnpm test',
    });
    const scriptWarning = warnings.find((w) => w.specifier === 'pnpm typecheck && pnpm test');
    expect(scriptWarning).toBeDefined();
    expect(scriptWarning?.message).toContain('"pnpm typecheck && pnpm test"');
  });

  it('does not warn about check script when checkScript option is not provided', () => {
    const warnings = checkTaskPermissions(testDir, { needsCommit: false });
    // With needsCommit:false and no checkScript, there should be no warnings
    expect(warnings).toHaveLength(0);
  });

  it('produces no warnings when Bash(*) is in allow list', async () => {
    const claudeDir = join(testDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] } }));

    const warnings = checkTaskPermissions(testDir, {
      provider: 'claude',
      needsCommit: true,
      checkScript: 'pnpm test',
    });
    expect(warnings).toHaveLength(0);
  });

  it('produces no commit warning when git commit:* is explicitly allowed', async () => {
    const claudeDir = join(testDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git commit:*)'] } })
    );

    const warnings = checkTaskPermissions(testDir, { provider: 'claude', needsCommit: true });
    const commitWarning = warnings.find((w) => w.specifier === 'git commit');
    expect(commitWarning).toBeUndefined();
  });

  it('produces no script warning when check script is covered by a prefix pattern', async () => {
    const claudeDir = join(testDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(pnpm*)'] } })
    );

    const warnings = checkTaskPermissions(testDir, {
      provider: 'claude',
      needsCommit: false,
      checkScript: 'pnpm typecheck && pnpm lint && pnpm test',
    });
    // pnpm* covers "pnpm typecheck..." specifier
    const scriptWarning = warnings.find((w) => w.tool === 'Bash' && w.specifier !== 'git commit');
    expect(scriptWarning).toBeUndefined();
  });

  it('warning message includes the check script name', () => {
    const script = 'make ci';
    const warnings = checkTaskPermissions(testDir, { needsCommit: false, checkScript: script });
    const scriptWarning = warnings.find((w) => w.specifier === script);
    expect(scriptWarning?.message).toContain(`"${script}"`);
  });

  it('can produce both commit and script warnings simultaneously when no permissions set', () => {
    const warnings = checkTaskPermissions(testDir, {
      needsCommit: true,
      checkScript: 'pnpm test',
    });
    // No settings → both operations need approval
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.some((w) => w.specifier === 'git commit')).toBe(true);
    expect(warnings.some((w) => w.specifier === 'pnpm test')).toBe(true);
  });
});
