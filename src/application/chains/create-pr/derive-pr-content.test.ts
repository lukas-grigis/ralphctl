import { describe, expect, it } from 'vitest';

import { makeApprovedTicket, makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import { derivePrContent } from './derive-pr-content.ts';

describe('derivePrContent', () => {
  it('uses sprint.name as the title', () => {
    const sprint = makeSprint({ name: 'Spring Cleaning' });
    const { title } = derivePrContent(sprint, []);
    expect(title).toBe('Spring Cleaning');
  });

  it('omits ## Tickets section when no tickets', () => {
    const sprint = makeSprint({ name: 'X' });
    const { body } = derivePrContent(sprint, []);
    expect(body).not.toContain('## Tickets');
    expect(body).toContain('# X');
    expect(body).toContain('— sprint id: `');
  });

  it('omits ## Tasks section when no done tasks', () => {
    const sprint = makeSprint();
    const todoTask = makeTask({ name: 'WIP' });
    const { body } = derivePrContent(sprint, [todoTask]);
    expect(body).not.toContain('## Tasks');
  });

  it('emits ## Tickets section listing each ticket title', () => {
    const ticket = makeApprovedTicket({ title: 'Add login' });
    const sprintBase = makeSprint();
    const added = sprintBase.addTicket(ticket);
    if (!added.ok) throw added.error;
    const { body } = derivePrContent(added.value, []);
    expect(body).toContain('## Tickets');
    expect(body).toContain('- Add login');
  });

  it('emits ## Tasks section listing only done task names', () => {
    const sprint = makeSprint();

    const todo = makeTask({ name: 'Skip me' });
    const inProgress = makeTask({ name: 'Working' }).markInProgress();
    if (!inProgress.ok) throw inProgress.error;
    const done = inProgress.value.markDone();
    if (!done.ok) throw done.error;

    const { body } = derivePrContent(sprint, [todo, done.value]);
    expect(body).toContain('## Tasks');
    expect(body).toContain('- Working');
    expect(body).not.toContain('- Skip me');
  });
});
