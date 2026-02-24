import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@src/utils/editor-input.ts', () => ({
  editorInput: vi.fn().mockResolvedValue(''),
}));

vi.mock('@src/store/project.ts', () => ({
  listProjects: vi.fn().mockResolvedValue([]),
  projectExists: vi.fn().mockResolvedValue(false),
}));

import { confirm } from '@inquirer/prompts';
import { addSingleTicketInteractive, ticketAddCommand } from './add.ts';

describe('ticketAddCommand — no projects', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exits loop without prompting "add another" when no projects exist', async () => {
    await ticketAddCommand({});

    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
  });

  it('addSingleTicketInteractive returns null when no projects exist', async () => {
    const result = await addSingleTicketInteractive({});
    expect(result).toBeNull();
  });
});
