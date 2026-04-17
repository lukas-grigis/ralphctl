import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptPort } from '@src/business/ports/prompt.ts';
import { addSingleTicketInteractive, ticketAddCommand } from './add.ts';

const confirmMock = vi.fn();
const inputMock = vi.fn();
const selectMock = vi.fn();
const checkboxMock = vi.fn();
const editorMock = vi.fn();
const fileBrowserMock = vi.fn();

const promptMock: PromptPort = {
  confirm: confirmMock,
  input: inputMock,
  select: selectMock,
  checkbox: checkboxMock,
  editor: editorMock,
  fileBrowser: fileBrowserMock,
};

vi.mock('@src/application/bootstrap.ts', () => ({
  getPrompt: vi.fn(() => promptMock),
}));

vi.mock('@src/integration/prompts/editor-input.ts', () => ({
  editorInput: vi.fn().mockResolvedValue(''),
}));

vi.mock('@src/integration/persistence/project.ts', () => ({
  listProjects: vi.fn().mockResolvedValue([]),
  projectExists: vi.fn().mockResolvedValue(false),
}));

describe('ticketAddCommand — no projects', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exits loop without prompting "add another" when no projects exist', async () => {
    await ticketAddCommand({});

    // getPrompt().confirm should not be called if we exited the loop early
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('addSingleTicketInteractive returns null when no projects exist', async () => {
    const result = await addSingleTicketInteractive({});
    expect(result).toBeNull();
  });
});
