import { describe, expect, it, vi } from 'vitest';

// Mock @inquirer/prompts before importing the module under test
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));

import { select } from '@inquirer/prompts';
import { escapableSelect } from './escapable.ts';

const selectMock = vi.mocked(select);

/** Create an error with a specific name, mimicking inquirer's error classes */
function makeNamedError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

describe('escapableSelect', () => {
  const config = {
    message: 'Pick one',
    choices: [
      { name: 'A', value: 'a' as const },
      { name: 'B', value: 'b' as const },
    ],
  };

  it('returns the selected value on normal selection', async () => {
    selectMock.mockResolvedValueOnce('a');

    const result = await escapableSelect(config);

    expect(result).toBe('a');
    expect(selectMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: config.message, choices: config.choices }),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('returns null when the prompt is aborted (Escape key)', async () => {
    selectMock.mockRejectedValueOnce(makeNamedError('AbortPromptError'));

    const result = await escapableSelect(config);

    expect(result).toBeNull();
  });

  it('propagates ExitPromptError (Ctrl+C)', async () => {
    const exitError = makeNamedError('ExitPromptError');
    selectMock.mockRejectedValueOnce(exitError);

    await expect(escapableSelect(config)).rejects.toThrow(exitError);
  });

  it('propagates unexpected errors', async () => {
    selectMock.mockRejectedValueOnce(new Error('unexpected'));

    await expect(escapableSelect(config)).rejects.toThrow('unexpected');
  });

  it('cleans up keypress listener after selection', async () => {
    const removeSpy = vi.spyOn(process.stdin, 'removeListener');
    selectMock.mockResolvedValueOnce('b');

    await escapableSelect(config);

    expect(removeSpy).toHaveBeenCalledWith('keypress', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('cleans up keypress listener after abort', async () => {
    const removeSpy = vi.spyOn(process.stdin, 'removeListener');
    selectMock.mockRejectedValueOnce(makeNamedError('AbortPromptError'));

    await escapableSelect(config);

    expect(removeSpy).toHaveBeenCalledWith('keypress', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('injects escape hint into theme keysHelpTip', async () => {
    selectMock.mockResolvedValueOnce('a');

    await escapableSelect(config);

    const passedConfig = selectMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const theme = passedConfig?.['theme'] as
      | { style?: { keysHelpTip?: (keys: [string, string][]) => string } }
      | undefined;
    const keysHelpTip = theme?.style?.keysHelpTip;

    expect(keysHelpTip).toBeTypeOf('function');

    if (keysHelpTip) {
      const result = keysHelpTip([['↑↓', 'navigate']]);
      expect(result).toContain('esc');
      expect(result).toContain('back');
    }
  });
});
