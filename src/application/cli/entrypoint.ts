/**
 * `entrypoint` — main CLI entry for the next-architecture binary.
 *
 * Builds a Commander program from the composition root's {@link SharedDeps}
 * graph and dispatches to the matching command file. Each command file
 * owns its own subtree (`attachX(group, deps)`); this module just wires
 * the groups together.
 *
 * Bare `ralphctl` falls through to the TUI mount path in task 18 — for
 * now, the entrypoint prints help. Non-TTY / piped invocations always
 * pick the plain-text path.
 */
import { Command } from 'commander';

import { getSharedDeps } from '../bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '../bootstrap/shared-deps.ts';
import { isFirstLaunch } from '../runtime/first-launch.ts';
import { detectLegacyLayout } from '../runtime/legacy-detector.ts';
import { mountInkApp } from '../tui/runtime/mount.tsx';
import { handleCompletionRequest } from './completion/handle.ts';
import { attachCompletion } from './commands/completion-install.ts';
import { attachConfigSet } from './commands/config-set.ts';
import { attachConfigShow } from './commands/config-show.ts';
import { attachDoctor } from './commands/doctor.ts';
import { attachProjectAdd } from './commands/project-add.ts';
import { attachProjectList } from './commands/project-list.ts';
import { attachProjectOnboard } from './commands/project-onboard.ts';
import { attachProjectRemove } from './commands/project-remove.ts';
import { attachProjectRepoAdd } from './commands/project-repo-add.ts';
import { attachProjectRepoRemove } from './commands/project-repo-remove.ts';
import { attachProjectShow } from './commands/project-show.ts';
import { attachSessionsAttach } from './commands/sessions-attach.ts';
import { attachSessionsDetach } from './commands/sessions-detach.ts';
import { attachSessionsKill } from './commands/sessions-kill.ts';
import { attachSessionsList } from './commands/sessions-list.ts';
import { attachSprintActivate } from './commands/sprint-activate.ts';
import { attachSprintClose } from './commands/sprint-close.ts';
import { attachSprintContext } from './commands/sprint-context.ts';
import { attachSprintCreate } from './commands/sprint-create.ts';
import { attachSprintCreatePr } from './commands/sprint-create-pr.ts';
import { attachSprintEdit } from './commands/sprint-edit.ts';
import { attachSprintFeedback } from './commands/sprint-feedback.ts';
import { attachSprintIdeate } from './commands/sprint-ideate.ts';
import { attachSprintList } from './commands/sprint-list.ts';
import { attachSprintPlan } from './commands/sprint-plan.ts';
import { attachSprintProgress } from './commands/sprint-progress.ts';
import { attachSprintRefine } from './commands/sprint-refine.ts';
import { attachSprintRemove } from './commands/sprint-remove.ts';
import { attachSprintRequirements } from './commands/sprint-requirements.ts';
import { attachSprintSetCurrent } from './commands/sprint-set-current.ts';
import { attachSprintShow } from './commands/sprint-show.ts';
import { attachSprintStart } from './commands/sprint-start.ts';
import { attachTaskAdd } from './commands/task-add.ts';
import { attachTaskEdit } from './commands/task-edit.ts';
import { attachTaskEditStatus } from './commands/task-edit-status.ts';
import { attachTaskList } from './commands/task-list.ts';
import { attachTaskRemove } from './commands/task-remove.ts';
import { attachTaskShow } from './commands/task-show.ts';
import { attachTicketAdd } from './commands/ticket-add.ts';
import { attachTicketApprove } from './commands/ticket-approve.ts';
import { attachTicketAssignRepos } from './commands/ticket-assign-repos.ts';
import { attachTicketEdit } from './commands/ticket-edit.ts';
import { attachTicketRemove } from './commands/ticket-remove.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from './exit-codes.ts';

export function buildProgram(deps: SharedDeps): Command {
  const program = new Command()
    .name('ralphctl')
    .description('Plug-and-play harness for long-running AI coding agents')
    .version(readPackageVersion());

  // Top-level — health + config.
  attachDoctor(program, deps);

  const config = program.command('config').description('view or change configuration');
  attachConfigShow(config, deps);
  attachConfigSet(config, deps);

  // Project group — CRUD + onboarding.
  const project = program.command('project').description('manage projects');
  attachProjectAdd(project, deps);
  attachProjectList(project, deps);
  attachProjectShow(project, deps);
  attachProjectRemove(project, deps);
  attachProjectRepoAdd(project, deps);
  attachProjectRepoRemove(project, deps);
  attachProjectOnboard(project, deps);

  // Sprint group — CRUD + workflows.
  const sprint = program.command('sprint').description('manage sprints + workflows');
  attachSprintCreate(sprint, deps);
  attachSprintEdit(sprint, deps);
  attachSprintSetCurrent(sprint, deps);
  attachSprintActivate(sprint, deps);
  attachSprintList(sprint, deps);
  attachSprintShow(sprint, deps);
  attachSprintRemove(sprint, deps);
  attachSprintClose(sprint, deps);
  attachSprintRefine(sprint, deps);
  attachSprintPlan(sprint, deps);
  attachSprintIdeate(sprint, deps);
  attachSprintStart(sprint, deps);
  attachSprintFeedback(sprint, deps);
  attachSprintCreatePr(sprint, deps);
  attachSprintProgress(sprint, deps);
  attachSprintRequirements(sprint, deps);
  attachSprintContext(sprint, deps);

  // Ticket group — CRUD.
  const ticket = program.command('ticket').description('manage tickets within a sprint');
  attachTicketAdd(ticket, deps);
  attachTicketEdit(ticket, deps);
  attachTicketApprove(ticket, deps);
  attachTicketAssignRepos(ticket, deps);
  attachTicketRemove(ticket, deps);

  // Task group — CRUD.
  const task = program.command('task').description('manage tasks within a sprint');
  attachTaskAdd(task, deps);
  attachTaskList(task, deps);
  attachTaskShow(task, deps);
  attachTaskEdit(task, deps);
  attachTaskEditStatus(task, deps);
  attachTaskRemove(task, deps);

  // Sessions — multi-chain runtime.
  const sessions = program.command('sessions').description('manage live chain sessions');
  attachSessionsList(sessions, deps);
  attachSessionsAttach(sessions, deps);
  attachSessionsDetach(sessions, deps);
  attachSessionsKill(sessions, deps);

  // Completion — shell tab-completion install + show.
  attachCompletion(program, deps);

  return program;
}

import packageJson from '../../../package.json' with { type: 'json' };

/**
 * Read package.json version at build time. tsup bundles the JSON via the
 * import attribute (`with { type: 'json' }`), so the version is constant in
 * the dist bundle and stays in sync with `package.json` on every build.
 */
function readPackageVersion(): string {
  return packageJson.version;
}

/**
 * Main entry — build the program, dispatch, and translate any uncaught
 * error into {@link EXIT_ERROR}. Bare `ralphctl` (no args) and the
 * explicit `interactive` subcommand mount the Ink TUI when stdout is a
 * TTY; otherwise the entrypoint falls back to Commander.
 */
export async function main(argv: readonly string[]): Promise<ExitCode> {
  // Legacy layout gate — must run BEFORE getSharedDeps(), since the
  // composition root assumes the new `<root>/config/` directory shape and
  // would silently start using a fresh layout next to the legacy data.
  // Skip during shell-completion calls so tab-completion never blocks.
  if (!isCompletionCall(argv)) {
    const legacy = await detectLegacyLayout();
    if (legacy.isLegacy) {
      process.stderr.write(`error: ${legacy.hint}\n`);
      return EXIT_ERROR;
    }
  }

  const deps = await getSharedDeps();

  // Build the program early so the completion intercept can introspect it
  // before any TUI mount path runs. The shell triggers completion by setting
  // COMP_* env vars and invoking `ralphctl completion -- <words…>`; we never
  // want the banner, the Ink app, or any other side effect on that path.
  const program = buildProgram(deps);

  const handled = await handleCompletionRequest(program, deps);
  if (handled) return EXIT_SUCCESS;

  if (shouldMountTui(argv)) {
    const result = await mountInkApp();
    if (!result.fallback) return EXIT_SUCCESS;
    // Non-TTY / CI fallback: surface a friendly first-launch hint instead
    // of dropping the user into Commander help when they have no projects
    // yet. Commander's `--help` is still one flag away.
    if (await isFirstLaunch({ projectRepo: deps.projectRepo, configStore: deps.configStore })) {
      process.stdout.write('No projects yet. Run `ralphctl project add` to get started.\n');
      return EXIT_SUCCESS;
    }
  }

  try {
    await program.parseAsync([...argv]);
    return EXIT_SUCCESS;
  } catch (err) {
    deps.logger.error('command failed', {
      error: serialiseError(err),
    });
    process.stderr.write(`error: ${formatError(err)}\n`);
    return EXIT_ERROR;
  }
}

/**
 * Shell tab-completion runs `ralphctl completion -- <words…>` with COMP_*
 * env vars set. We must not surface any error or prompt on that path —
 * any stderr write derails the completion script.
 */
function isCompletionCall(argv: readonly string[]): boolean {
  const userArgs = argv.slice(2);
  return userArgs[0] === 'completion';
}

/**
 * `argv` is the full Node argv (`[node, script, ...userArgs]`). The TUI
 * mounts when the user passed no subcommand or the literal `interactive`
 * keyword.
 */
function shouldMountTui(argv: readonly string[]): boolean {
  const userArgs = argv.slice(2);
  if (userArgs.length === 0) return true;
  if (userArgs.length === 1 && userArgs[0] === 'interactive') return true;
  return false;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function serialiseError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}

// Run when invoked as a script (tsx, node, or bin shim). The check uses
// `import.meta.url` against the process entry so tests that import this
// module don't trigger a top-level CLI dispatch.
//
// When running under tsx, `process.argv[1]` is the source `.ts` file
// (`entrypoint.ts`). When bundled via tsup, the entry is `dist/cli.mjs`
// (the file name comes from `tsup.config.ts`'s `entry: { cli: ... }`).
// Match either form, plus a generic `cli.{mjs,js}` for npm-installed
// invocations under `node_modules/.bin/`.
function shouldAutoInvoke(): boolean {
  if (process.env['VITEST'] !== undefined) return false;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const base = entry.split('/').pop() ?? '';
  // Accept `entrypoint.{ts,mjs,js}` (dev / direct invocation) and
  // `cli.{mjs,js}` (the bundled binary name configured by tsup).
  if (!/^(entrypoint|cli)\.(ts|mjs|js)$/.test(base)) return false;
  return true;
}

if (shouldAutoInvoke()) {
  void main(process.argv).then((code) => {
    if (code !== EXIT_SUCCESS) process.exit(code);
  });
}
