/**
 * `ralphctl task list` used to print a bare `[blocked ]` with no reason and no pointer to the
 * recovery hatch — discoverable only by reading `--help`. It now prints the first line of
 * `blockedReason` and a `recover with: ralphctl task unblock <id>` footer under every blocked
 * entry, plus the generator's own structured triage (`blockerClass` / `question` /
 * `whatUnblocksMe`) when a task-blocked signal supplied it, so "why is this blocked" is answerable
 * without opening the TUI.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { makeDraftSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl task list — blocked reason + recover hint', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('prints the reason first line and a task-scoped recover hint under a blocked entry', async () => {
    const sprint = makeDraftSprint();
    const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
    const blocked = markTaskBlocked(
      makeTodoTask({ name: 'wedged' }),
      'generator self-blocked\nstash: ralphctl/sprint/wedged/blocked-diff',
      'own'
    );
    if (!blocked.ok) throw new Error(`fixture: ${blocked.error.message}`);
    await repo.saveAll(sprint.id, [blocked.value]);

    const result = await runCliCaptured(cli, ['task', 'list', '--sprint', String(sprint.id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('wedged');
    // Only the FIRST line of a multi-line reason is echoed — the stash handle on the second
    // line is available via `task show`, not duplicated into the list view.
    expect(result.stdout).toContain('generator self-blocked');
    expect(result.stdout).not.toContain('blocked-diff');
    expect(result.stdout).toContain(`recover with: ralphctl task unblock ${String(blocked.value.id)}`);
  });

  it('does not print a reason line or recover hint for a non-blocked task', async () => {
    const sprint = makeDraftSprint();
    const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
    await repo.saveAll(sprint.id, [makeTodoTask({ name: 'fine' })]);

    const result = await runCliCaptured(cli, ['task', 'list', '--sprint', String(sprint.id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('recover with');
  });

  it("prints the generator's structured block triage when the task carries it", async () => {
    const sprint = makeDraftSprint();
    const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
    const blocked = markTaskBlocked(makeTodoTask({ name: 'needs-input' }), 'generator self-blocked', 'own');
    if (!blocked.ok) throw new Error(`fixture: ${blocked.error.message}`);
    // Not yet populated by any production caller (the ctx → leaf wiring is tracked separately) —
    // constructed directly here to pin the CLI's rendering of the fields once they ARE populated.
    await repo.saveAll(sprint.id, [
      {
        ...blocked.value,
        blockerClass: 'missing-information',
        question: 'Which database should this task connect to?',
        whatUnblocksMe: 'Confirm the target database name.',
      },
    ]);

    const result = await runCliCaptured(cli, ['task', 'list', '--sprint', String(sprint.id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('blocker: missing-information');
    expect(result.stdout).toContain('question: Which database should this task connect to?');
    expect(result.stdout).toContain('unblocks with: Confirm the target database name.');
  });

  // The triage fields — and the task NAME, which the planner writes off the same generator — are
  // model-authored prose off a run that has just read the target repository, so a prompt-injected
  // answer can carry terminal escape sequences. `task list` writes them to stdout, which is where
  // the operator's terminal would EXECUTE them — window title, screen clear, OSC 52 clipboard
  // write. They are stripped on the way out.
  it('strips terminal escape sequences out of the model-authored name and triage text', async () => {
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const sprint = makeDraftSprint();
    const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
    const blocked = markTaskBlocked(
      makeTodoTask({ name: `${esc}]0;owned${bel}injected` }),
      `${esc}[2Jcleared your screen`,
      'own'
    );
    if (!blocked.ok) throw new Error(`fixture: ${blocked.error.message}`);
    await repo.saveAll(sprint.id, [
      {
        ...blocked.value,
        question: `${esc}]0;pwned${bel}Which database?`,
        whatUnblocksMe: `${esc}[31mConfirm the name.${esc}[0m`,
      },
    ]);

    const result = await runCliCaptured(cli, ['task', 'list', '--sprint', String(sprint.id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(esc);
    expect(result.stdout).not.toContain(bel);
    // Neutered, not dropped — the operator still reads what the generator actually said.
    expect(result.stdout).toContain(']0;ownedinjected');
    expect(result.stdout).toContain('Which database?');
    expect(result.stdout).toContain('Confirm the name.');
    expect(result.stdout).toContain('cleared your screen');
  });

  // The name rides on EVERY row, not just blocked ones — a `todo` task never reaches the triage
  // branch of `formatTaskLine`, so its head line is the only thing printed for it.
  it('strips escape sequences from the name of a non-blocked task too', async () => {
    const esc = String.fromCharCode(0x1b);
    const sprint = makeDraftSprint();
    const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
    await repo.saveAll(sprint.id, [makeTodoTask({ name: `${esc}[2Jwipe-the-screen` })]);

    const result = await runCliCaptured(cli, ['task', 'list', '--sprint', String(sprint.id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(esc);
    expect(result.stdout).toContain('[2Jwipe-the-screen');
  });

  it('clamps a runaway triage field instead of flooding the row', async () => {
    const sprint = makeDraftSprint();
    const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
    const blocked = markTaskBlocked(makeTodoTask({ name: 'flooded' }), 'own failure', 'own');
    if (!blocked.ok) throw new Error(`fixture: ${blocked.error.message}`);
    await repo.saveAll(sprint.id, [{ ...blocked.value, question: 'q'.repeat(50_000) }]);

    const result = await runCliCaptured(cli, ['task', 'list', '--sprint', String(sprint.id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('…');
    expect(result.stdout.length).toBeLessThan(2_000);
    // The footer is still reachable — the point of clamping per field rather than per line.
    expect(result.stdout).toContain('recover with: ralphctl task unblock');
  });

  it('omits the triage lines when the task carries no structured block triage', async () => {
    const sprint = makeDraftSprint();
    const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
    const blocked = markTaskBlocked(makeTodoTask({ name: 'plain-block' }), 'own failure', 'own');
    if (!blocked.ok) throw new Error(`fixture: ${blocked.error.message}`);
    await repo.saveAll(sprint.id, [blocked.value]);

    const result = await runCliCaptured(cli, ['task', 'list', '--sprint', String(sprint.id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('blocker:');
    expect(result.stdout).not.toContain('question:');
    expect(result.stdout).not.toContain('unblocks with:');
  });
});
