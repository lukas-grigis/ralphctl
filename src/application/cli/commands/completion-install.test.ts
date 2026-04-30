/**
 * Tests for `completion install` / `completion show`.
 *
 * - `show` is pure — print to stdout for the requested shell.
 * - `install` writes to the user's rc file. We point HOME at a temp dir
 *   so we can verify idempotent behaviour without polluting real
 *   shell config.
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSharedDeps, type SharedDeps } from '../../bootstrap/shared-deps.ts';
import { resolveStoragePaths, type StoragePaths } from '../../runtime/storage-paths-resolver.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { EXIT_ERROR, EXIT_SUCCESS } from '../exit-codes.ts';
import {
  buildCompletionScript,
  rcFileForShell,
  resolveShell,
  runCompletionInstall,
  runCompletionShow,
} from './completion-install.ts';

interface CapturedIo {
  readonly stdout: string;
  readonly stderr: string;
}

async function captureIo<T>(body: () => Promise<T>): Promise<{ result: T; io: CapturedIo }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  try {
    const result = await body();
    return { result, io: { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') } };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(
      tmpdir(),
      `ralphctl-completion-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
    )
  );
}

describe('completion install / show', () => {
  let root: AbsolutePath;
  let storage: StoragePaths;
  let deps: SharedDeps;
  let originalHome: string | undefined;
  let originalShell: string | undefined;

  beforeEach(async () => {
    root = uniqueRoot();
    await mkdir(root, { recursive: true });
    storage = resolveStoragePaths({ root });
    deps = await createSharedDeps({ storage, logSink: 'plain-text' });

    originalHome = process.env['HOME'];
    originalShell = process.env['SHELL'];
    // Point HOME at our temp dir so rc files write here.
    process.env['HOME'] = String(root);
  });

  afterEach(async () => {
    await deps.sessionManager.dispose();
    await rm(root, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
    else delete process.env['HOME'];
    if (originalShell !== undefined) process.env['SHELL'] = originalShell;
    else delete process.env['SHELL'];
  });

  describe('resolveShell', () => {
    it('returns the requested shell when explicit', () => {
      expect(resolveShell('zsh')).toBe('zsh');
      expect(resolveShell('bash')).toBe('bash');
    });

    it('falls back to $SHELL basename', () => {
      process.env['SHELL'] = '/usr/local/bin/zsh';
      expect(resolveShell(undefined)).toBe('zsh');
    });

    it('defaults to bash when $SHELL is unset', () => {
      delete process.env['SHELL'];
      expect(resolveShell(undefined)).toBe('bash');
    });
  });

  describe('buildCompletionScript', () => {
    it('renders a bash script with the binary name', () => {
      const script = buildCompletionScript('bash', 'ralphctl');
      expect(script).toContain('_ralphctl_completion');
      expect(script).toContain('ralphctl completion --');
      expect(script).toContain('complete -o default');
    });

    it('renders a zsh script with compdef', () => {
      const script = buildCompletionScript('zsh', 'ralphctl');
      expect(script).toContain('compdef _ralphctl_completion ralphctl');
    });

    it('renders a fish script with complete -c', () => {
      const script = buildCompletionScript('fish', 'ralphctl');
      expect(script).toContain('function _ralphctl_completion');
      expect(script).toContain('complete -f -d');
    });
  });

  describe('runCompletionShow', () => {
    it('prints a bash script to stdout', async () => {
      const { result, io } = await captureIo(() => runCompletionShow('bash'));
      expect(result).toBe(EXIT_SUCCESS);
      expect(io.stdout).toContain('_ralphctl_completion');
    });

    it('errors on an unsupported shell', async () => {
      const { result, io } = await captureIo(() => runCompletionShow('powershell'));
      expect(result).toBe(EXIT_ERROR);
      expect(io.stderr).toContain('unsupported shell');
    });
  });

  describe('runCompletionInstall', () => {
    it('appends a completion block to a fresh bash rc file', async () => {
      const { result } = await captureIo(() => runCompletionInstall(deps, 'bash'));
      expect(result).toBe(EXIT_SUCCESS);
      const rcPath = rcFileForShell('bash');
      const contents = await readFile(rcPath, 'utf-8');
      expect(contents).toContain('###-begin-ralphctl-completion-###');
      expect(contents).toContain('_ralphctl_completion');
    });

    it('is idempotent — reinstall does not duplicate the block', async () => {
      await captureIo(() => runCompletionInstall(deps, 'bash'));
      const rcPath = rcFileForShell('bash');
      const first = await readFile(rcPath, 'utf-8');
      const { io } = await captureIo(() => runCompletionInstall(deps, 'bash'));
      const second = await readFile(rcPath, 'utf-8');
      expect(second).toBe(first);
      expect(io.stdout).toContain('already installed');
    });

    it('rejects an unsupported shell', async () => {
      const { result, io } = await captureIo(() => runCompletionInstall(deps, 'tcsh'));
      expect(result).toBe(EXIT_ERROR);
      expect(io.stderr).toContain('unsupported shell');
    });

    it('creates the zsh rc file when it does not exist', async () => {
      const { result } = await captureIo(() => runCompletionInstall(deps, 'zsh'));
      expect(result).toBe(EXIT_SUCCESS);
      const rcPath = rcFileForShell('zsh');
      const stats = await stat(rcPath);
      expect(stats.isFile()).toBe(true);
    });
  });
});
