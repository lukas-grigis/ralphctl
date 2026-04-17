import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptCancelledError } from '@src/business/ports/prompt.ts';
import { escapableSelect } from './escapable.ts';

const selectMock = vi.fn();
const confirmMock = vi.fn();
const inputMock = vi.fn();
const checkboxMock = vi.fn();
const editorMock = vi.fn();
const fileBrowserMock = vi.fn();

vi.mock('@src/integration/bootstrap.ts', () => ({
  getPrompt: () => ({
    select: selectMock,
    confirm: confirmMock,
    input: inputMock,
    checkbox: checkboxMock,
    editor: editorMock,
    fileBrowser: fileBrowserMock,
  }),
  getSharedDeps: vi.fn(),
  setSharedDeps: vi.fn(),
}));

describe('escapableSelect', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

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
      expect.objectContaining({
        message: config.message,
        choices: [
          expect.objectContaining({ label: 'A', value: 'a' }),
          expect.objectContaining({ label: 'B', value: 'b' }),
        ],
      })
    );
  });

  it('returns null when the prompt is cancelled (Escape)', async () => {
    selectMock.mockRejectedValueOnce(new PromptCancelledError());

    const result = await escapableSelect(config);

    expect(result).toBeNull();
  });

  it('returns null when the prompt is cancelled (Ctrl+C surfaces as PromptCancelledError)', async () => {
    // Ctrl+C and Escape both reach this wrapper as PromptCancelledError; the
    // wrapper collapses both into `null` for callers.
    selectMock.mockRejectedValueOnce(new PromptCancelledError('User pressed Ctrl+C'));

    const result = await escapableSelect(config);

    expect(result).toBeNull();
  });

  it('propagates unexpected errors', async () => {
    selectMock.mockRejectedValueOnce(new Error('unexpected'));

    await expect(escapableSelect(config)).rejects.toThrow('unexpected');
  });

  it('maps choice shape (name → label)', async () => {
    selectMock.mockResolvedValueOnce('a');

    await escapableSelect({
      message: 'Pick',
      choices: [
        { name: 'Alpha', value: 'a' as const, description: 'first' },
        { name: 'Beta', value: 'b' as const, disabled: 'unavailable' },
      ],
    });

    const passed = selectMock.mock.calls[0]?.[0] as {
      choices: { label: string; value: string; description?: string; disabled?: boolean | string }[];
    };
    expect(passed.choices).toEqual([
      { label: 'Alpha', value: 'a', description: 'first', disabled: undefined },
      { label: 'Beta', value: 'b', description: undefined, disabled: 'unavailable' },
    ]);
  });

  it('renders separator items as disabled entries', async () => {
    selectMock.mockResolvedValueOnce('a');

    await escapableSelect({
      message: 'Pick',
      choices: [{ separator: '── SECTION ──' }, { name: 'A', value: 'a' as const }],
    });

    const passed = selectMock.mock.calls[0]?.[0] as {
      choices: { label: string; value: unknown; disabled?: boolean | string }[];
    };
    expect(passed.choices[0]).toEqual(expect.objectContaining({ disabled: true }));
    expect(passed.choices[0]?.label).toContain('SECTION');
    expect(passed.choices[1]).toEqual(expect.objectContaining({ label: 'A', value: 'a' }));
  });
});
