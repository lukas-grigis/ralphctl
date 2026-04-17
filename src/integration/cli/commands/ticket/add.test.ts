import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptPort } from '@src/business/ports/prompt.ts';

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

const addTicketMock = vi.fn();
const getCurrentSprintOrThrowMock = vi.fn();
const getProjectByIdMock = vi.fn();

vi.mock('@src/application/bootstrap.ts', () => ({
  getPrompt: vi.fn(() => promptMock),
}));

vi.mock('@src/integration/ui/prompts/editor-input.ts', () => ({
  editorInput: vi.fn().mockResolvedValue({ ok: true, value: '' }),
}));

vi.mock('@src/integration/persistence/ticket.ts', () => ({
  addTicket: (input: unknown): Promise<unknown> => addTicketMock(input) as Promise<unknown>,
}));

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  getCurrentSprintOrThrow: (): Promise<unknown> => getCurrentSprintOrThrowMock() as Promise<unknown>,
  SprintStatusError: class SprintStatusError extends Error {},
}));

vi.mock('@src/integration/persistence/project.ts', () => ({
  getProjectById: (id: string): Promise<unknown> => getProjectByIdMock(id) as Promise<unknown>,
}));

import { ticketAddCommand, addSingleTicketInteractive } from './add.ts';

describe('ticketAddCommand', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('inherits project from current sprint — no project prompt', async () => {
    getCurrentSprintOrThrowMock.mockResolvedValue({ id: 's1', projectId: 'prj00001', status: 'draft' });
    getProjectByIdMock.mockResolvedValue({ id: 'prj00001', name: 'p', displayName: 'P', repositories: [] });
    inputMock.mockResolvedValueOnce(''); // link (empty)
    inputMock.mockResolvedValueOnce('My ticket'); // title
    editorMock.mockResolvedValue('');
    addTicketMock.mockResolvedValue({ id: 't1', title: 'My ticket', requirementStatus: 'pending' });
    confirmMock.mockResolvedValue(false); // don't add another

    await ticketAddCommand({});

    expect(addTicketMock).toHaveBeenCalled();
    // Select was not called to pick a project — project is inherited from sprint.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('addSingleTicketInteractive passes no projectName to addTicket', async () => {
    inputMock.mockResolvedValueOnce('');
    inputMock.mockResolvedValueOnce('New');
    editorMock.mockResolvedValue('');
    addTicketMock.mockResolvedValue({ id: 't2', title: 'New', requirementStatus: 'pending' });

    const result = await addSingleTicketInteractive({});
    expect(result?.title).toBe('New');
    const call = addTicketMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('projectName');
  });
});
