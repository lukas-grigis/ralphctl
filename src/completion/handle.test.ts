import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

describe('handleCompletionRequest', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns false when COMP_ env vars are absent', async () => {
    delete process.env['COMP_CWORD'];
    delete process.env['COMP_POINT'];
    delete process.env['COMP_LINE'];

    const { handleCompletionRequest } = await import('./handle.ts');
    const program = new Command();
    program.name('ralphctl');

    const result = await handleCompletionRequest(program);
    expect(result).toBe(false);
  });

  it('returns true when COMP_ env vars are present', async () => {
    process.env['COMP_CWORD'] = '1';
    process.env['COMP_POINT'] = '9';
    process.env['COMP_LINE'] = 'ralphctl ';

    // Mock tabtab
    vi.doMock('tabtab', () => ({
      default: {
        parseEnv: vi.fn().mockReturnValue({
          line: 'ralphctl ',
          last: '',
          prev: 'ralphctl',
          partial: 'ralphctl ',
          lastPartial: '',
          words: 1,
          point: 9,
          complete: true,
        }),
        log: vi.fn(),
      },
    }));

    // Mock resolver
    vi.doMock('@src/completion/resolver.ts', () => ({
      resolveCompletions: vi.fn().mockResolvedValue([{ name: 'sprint', description: 'Manage sprints' }]),
    }));

    const { handleCompletionRequest } = await import('./handle.ts');
    const program = new Command();
    program.name('ralphctl');

    const result = await handleCompletionRequest(program);
    expect(result).toBe(true);

    vi.doUnmock('tabtab');
    vi.doUnmock('@src/completion/resolver.ts');
  });

  it('does not produce banner output', async () => {
    process.env['COMP_CWORD'] = '1';
    process.env['COMP_POINT'] = '9';
    process.env['COMP_LINE'] = 'ralphctl ';

    const logSpy = vi.fn();

    vi.doMock('tabtab', () => ({
      default: {
        parseEnv: vi.fn().mockReturnValue({
          line: 'ralphctl ',
          last: '',
          prev: 'ralphctl',
          partial: 'ralphctl ',
          lastPartial: '',
          words: 1,
          point: 9,
          complete: true,
        }),
        log: logSpy,
      },
    }));

    vi.doMock('@src/completion/resolver.ts', () => ({
      resolveCompletions: vi.fn().mockResolvedValue([{ name: 'sprint' }]),
    }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { handleCompletionRequest } = await import('./handle.ts');
    const program = new Command();
    program.name('ralphctl');

    await handleCompletionRequest(program);

    // tabtab.log was called with completions (not console.log with a banner)
    expect(logSpy).toHaveBeenCalledWith([{ name: 'sprint' }]);
    // No banner-style output
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.doUnmock('tabtab');
    vi.doUnmock('@src/completion/resolver.ts');
  });
});
