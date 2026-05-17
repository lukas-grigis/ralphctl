import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { addTicket } from '@src/domain/entity/sprint.ts';
import { makeApprovedTicket, makeDraftSprint, makePendingTicket, makePlannedSprint } from '@tests/fixtures/domain.ts';
import { createCliHome, runCliCaptured, type CliHome } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl ticket', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  describe('list', () => {
    it('reports the empty state when the sprint has no tickets', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const sprint = makeDraftSprint();
      await repo.save(sprint);

      const result = await runCliCaptured(cli, ['ticket', 'list', '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no tickets on this sprint yet');
    });

    it('lists each ticket with id + status + title', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const ticketA = makePendingTicket({ title: 'login bug' });
      const ticketB = makePendingTicket({ title: 'cache eviction' });
      const empty = makeDraftSprint();
      const withA = addTicket(empty, ticketA);
      if (!withA.ok) throw new Error('fixture: addTicket A failed');
      const withBoth = addTicket(withA.value, ticketB);
      if (!withBoth.ok) throw new Error('fixture: addTicket B failed');
      await repo.save(withBoth.value);
      const sprint = withBoth.value;

      const result = await runCliCaptured(cli, ['ticket', 'list', '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('login bug');
      expect(result.stdout).toContain('cache eviction');
      expect(result.stdout).toContain('pending');
    });

    it('exits 1 when the sprint id is malformed', async () => {
      const result = await runCliCaptured(cli, ['ticket', 'list', '--sprint', 'not-a-uuid']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid sprint id');
    });
  });

  describe('show <ticketId>', () => {
    it('prints the ticket as JSON', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const ticket = makeApprovedTicket({ title: 'shipping' });
      const sprint = makeDraftSprint({ tickets: [ticket] });
      await repo.save(sprint);

      const result = await runCliCaptured(cli, ['ticket', 'show', String(ticket.id), '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { readonly id: string; readonly title: string };
      expect(parsed.id).toBe(String(ticket.id));
      expect(parsed.title).toBe('shipping');
    });

    it('exits 1 when the ticket does not exist on the sprint', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const sprint = makeDraftSprint();
      await repo.save(sprint);

      const result = await runCliCaptured(cli, [
        'ticket',
        'show',
        '01900000-0000-7000-8000-00000000ffff',
        '--sprint',
        String(sprint.id),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('add', () => {
    it('appends a pending ticket to a draft sprint', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const sprint = makeDraftSprint();
      await repo.save(sprint);

      const result = await runCliCaptured(cli, [
        'ticket',
        'add',
        '--sprint',
        String(sprint.id),
        '--title',
        'add metrics dashboard',
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('added ticket');
      expect(result.stdout).toContain('add metrics dashboard');

      const reloaded = await repo.findById(sprint.id);
      expect(reloaded.ok).toBe(true);
      if (!reloaded.ok) return;
      expect(reloaded.value.tickets).toHaveLength(1);
      expect(reloaded.value.tickets[0]?.title).toBe('add metrics dashboard');
    });

    it('exits 1 when the sprint is not in draft status (invariant violated)', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const planned = makePlannedSprint();
      await repo.save(planned);

      const result = await runCliCaptured(cli, [
        'ticket',
        'add',
        '--sprint',
        String(planned.id),
        '--title',
        'too late',
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('error:');
    });
  });

  describe('remove', () => {
    it('drops the ticket and reports the remaining count', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const ticketA = makePendingTicket({ title: 'doomed' });
      const ticketB = makePendingTicket({ title: 'survives' });
      const empty = makeDraftSprint();
      const withA = addTicket(empty, ticketA);
      if (!withA.ok) throw new Error('fixture: addTicket A failed');
      const withBoth = addTicket(withA.value, ticketB);
      if (!withBoth.ok) throw new Error('fixture: addTicket B failed');
      await repo.save(withBoth.value);
      const sprint = withBoth.value;

      const result = await runCliCaptured(cli, ['ticket', 'remove', String(ticketA.id), '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`removed ticket ${String(ticketA.id)}`);
      expect(result.stdout).toContain('1 ticket remain');

      const reloaded = await repo.findById(sprint.id);
      if (!reloaded.ok) throw new Error('reload failed');
      expect(reloaded.value.tickets.map((t) => t.id)).toEqual([ticketB.id]);
    });

    it('exits 1 when the ticket does not exist (idempotent surface, but loud for CLI)', async () => {
      const repo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const sprint = makeDraftSprint();
      await repo.save(sprint);

      const result = await runCliCaptured(cli, [
        'ticket',
        'remove',
        '01900000-0000-7000-8000-00000000ffff',
        '--sprint',
        String(sprint.id),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });
});
