/**
 * ProviderAiSessionAdapter tests — focused on the terminal-handoff contract.
 *
 * The raw `spawnInteractive` uses `stdio: 'inherit'` and is inherently a
 * filesystem-spawning action; we don't drive the real child here. Instead we
 * stub the low-level functions and the suspend module, then verify that
 * `spawnInteractive` runs the spawn *inside* `withSuspendedTui`, while
 * `spawnHeadless` / `spawnWithRetry` do not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

interface HeadlessResult {
  stdout: string;
  sessionId?: string | null;
  model?: string | null;
}

const spawnInteractiveMock =
  vi.fn<(prompt: string, options: unknown, provider: unknown) => { code: number; error?: string }>();
const spawnHeadlessRawMock = vi.fn<(...args: unknown[]) => Promise<HeadlessResult>>();
const spawnWithRetryMock = vi.fn<(...args: unknown[]) => Promise<HeadlessResult>>();

vi.mock('@src/integration/ai/session.ts', () => ({
  spawnInteractive: (prompt: string, options: unknown, provider: unknown): { code: number; error?: string } =>
    spawnInteractiveMock(prompt, options, provider),
  spawnHeadlessRaw: (...args: unknown[]): Promise<HeadlessResult> => spawnHeadlessRawMock(...args),
  spawnWithRetry: (...args: unknown[]): Promise<HeadlessResult> => spawnWithRetryMock(...args),
}));

const withSuspendedTuiMock = vi.fn(<T>(cb: () => T | Promise<T>): Promise<T> => Promise.resolve(cb()));

vi.mock('@src/integration/ui/tui/runtime/suspend.ts', () => ({
  withSuspendedTui: <T>(cb: () => T | Promise<T>) => withSuspendedTuiMock(cb),
}));

vi.mock('@src/integration/ai/providers/registry.ts', () => ({
  getActiveProvider: () =>
    Promise.resolve({
      name: 'claude',
      displayName: 'Claude Code',
      binary: 'claude',
      baseArgs: [],
      buildInteractiveArgs: (prompt: string) => [prompt],
      getSpawnEnv: () => ({}),
    }),
}));

import { ProviderAiSessionAdapter } from './session-adapter.ts';

describe('ProviderAiSessionAdapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('spawnInteractive', () => {
    it('runs the spawn inside withSuspendedTui', async () => {
      spawnInteractiveMock.mockReturnValue({ code: 0 });
      const adapter = new ProviderAiSessionAdapter();

      await adapter.spawnInteractive('hello', { cwd: '/tmp/repo' });

      expect(withSuspendedTuiMock).toHaveBeenCalledOnce();
      expect(spawnInteractiveMock).toHaveBeenCalledOnce();
      // The spawn must have run inside the callback passed to withSuspendedTui.
      // Because the mock implementation of withSuspendedTui just awaits the
      // callback, the spawn's mock is called as a side effect.
      const [cbCall] = withSuspendedTuiMock.mock.invocationCallOrder;
      const [spawnCall] = spawnInteractiveMock.mock.invocationCallOrder;
      expect(cbCall).toBeDefined();
      expect(spawnCall).toBeDefined();
      expect((cbCall ?? 0) < (spawnCall ?? 0)).toBe(true);
    });

    it('propagates spawn errors out of the suspend wrapper', async () => {
      spawnInteractiveMock.mockReturnValue({ code: 1, error: 'Failed to spawn claude CLI: boom' });
      const adapter = new ProviderAiSessionAdapter();

      await expect(adapter.spawnInteractive('hello', { cwd: '/tmp/repo' })).rejects.toThrow(
        'Failed to spawn claude CLI: boom'
      );
      expect(withSuspendedTuiMock).toHaveBeenCalledOnce();
    });

    it('returns normally on a successful spawn', async () => {
      spawnInteractiveMock.mockReturnValue({ code: 0 });
      const adapter = new ProviderAiSessionAdapter();

      await expect(adapter.spawnInteractive('prompt', { cwd: '/tmp/repo' })).resolves.toBeUndefined();
    });
  });

  describe('headless methods — no handoff needed', () => {
    it('spawnHeadless does not suspend the TUI', async () => {
      spawnHeadlessRawMock.mockResolvedValue({ stdout: 'out', sessionId: 's', model: 'm' });
      const adapter = new ProviderAiSessionAdapter();

      await adapter.spawnHeadless('prompt', { cwd: '/tmp/repo' });

      expect(withSuspendedTuiMock).not.toHaveBeenCalled();
      expect(spawnHeadlessRawMock).toHaveBeenCalledOnce();
    });

    it('spawnWithRetry does not suspend the TUI', async () => {
      spawnWithRetryMock.mockResolvedValue({ stdout: 'out', sessionId: 's', model: 'm' });
      const adapter = new ProviderAiSessionAdapter();

      await adapter.spawnWithRetry('prompt', { cwd: '/tmp/repo' });

      expect(withSuspendedTuiMock).not.toHaveBeenCalled();
      expect(spawnWithRetryMock).toHaveBeenCalledOnce();
    });
  });
});
