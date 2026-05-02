import { describe, expect, it } from 'vitest';

import { TaskId } from './task-id.ts';
import { TicketId } from './ticket-id.ts';

describe('TaskId', () => {
  it('accepts 8 lowercase hex chars', () => {
    const r = TaskId.parse('abcd1234');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('abcd1234');
  });

  it('accepts all-zero hex string', () => {
    const r = TaskId.parse('00000000');
    expect(r.ok).toBe(true);
  });

  it('rejects uppercase', () => {
    const r = TaskId.parse('ABCD1234');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('task-id');
      expect(r.error.value).toBe('ABCD1234');
    }
  });

  it('rejects wrong length', () => {
    const r = TaskId.parse('abc123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('task-id');
  });

  it('rejects non-string input', () => {
    const r = TaskId.parse(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('task-id');
  });

  it('generate() produces a parseable TaskId', () => {
    const id = TaskId.generate();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(TaskId.parse(id).ok).toBe(true);
  });

  it('TaskId and TicketId have distinct brands at the type level', () => {
    const taskR = TaskId.parse('abcd1234');
    const ticketR = TicketId.parse('abcd1234');
    expect(taskR.ok && ticketR.ok).toBe(true);
    if (!taskR.ok || !ticketR.ok) return;

    const task: TaskId = taskR.value;
    const ticket: TicketId = ticketR.value;

    // @ts-expect-error a TaskId cannot satisfy TicketId
    const _bad1: TicketId = task;
    // @ts-expect-error a TicketId cannot satisfy TaskId
    const _bad2: TaskId = ticket;

    void _bad1;
    void _bad2;
  });

  it('trustString returns the input typed as a TaskId', () => {
    const id: TaskId = TaskId.trustString('feedface');
    expect(id).toBe('feedface');
  });
});
