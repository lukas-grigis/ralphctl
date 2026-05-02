/**
 * `sprint create-pr` — open a pull / merge request from the sprint branch.
 *
 * Builds the create-pr chain via {@link createCreatePrFlow} and streams it
 * through {@link SessionManagerPort}. Defaults for `--title` / `--body`
 * fall through to the chain's `derive-pr-content` step; `--body -` reads
 * the body from stdin.
 */
import type { Command } from 'commander';

import { createCreatePrFlow, type CreatePrCtx } from '@src/application/chains/create-pr/create-pr-flow.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { printError } from '@src/application/cli/command-runner.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { streamSession } from '@src/application/cli/stream-session.ts';

interface SprintCreatePrFlags {
  readonly sprint?: string;
  readonly base?: string;
  readonly title?: string;
  readonly body?: string;
  readonly draft?: boolean;
  readonly cwd?: string;
}

export function attachSprintCreatePr(group: Command, deps: SharedDeps): void {
  group
    .command('create-pr')
    .description('open a pull/merge request from the sprint branch')
    .option('--sprint <id>', 'sprint id (defaults to currentSprint)')
    .option('--base <branch>', 'target branch on the remote', 'main')
    .option('--title <text>', 'PR title (defaults to sprint name)')
    .option('--body <text>', 'PR body (defaults to derived markdown; pass `-` to read from stdin)')
    .option('--draft', 'open as draft PR')
    .option('--cwd <abs>', 'working directory for git/gh/glab', process.cwd())
    .action(async (opts: SprintCreatePrFlags) => {
      const code = await runSprintCreatePr(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintCreatePr(deps: SharedDeps, opts: SprintCreatePrFlags): Promise<ExitCode> {
  // Resolve sprint id — explicit flag wins, else use config.currentSprint.
  let sprintIdStr: string | undefined = opts.sprint;
  if (sprintIdStr === undefined) {
    const config = await deps.configStore.load();
    if (config.ok && config.value.currentSprint) {
      sprintIdStr = config.value.currentSprint;
    }
  }
  if (sprintIdStr === undefined) {
    process.stderr.write('error: no sprint id provided and no current sprint configured\n');
    return EXIT_ERROR;
  }
  const sprintId = SprintId.parse(sprintIdStr);
  if (!sprintId.ok) {
    printError(deps, sprintId.error);
    return EXIT_ERROR;
  }

  const cwd = AbsolutePath.parse(opts.cwd ?? process.cwd());
  if (!cwd.ok) {
    printError(deps, cwd.error);
    return EXIT_ERROR;
  }

  // Validate the sprint has a branch (chain re-checks, but a friendlier
  // error here saves a round-trip).
  const sprintLoaded = await deps.sprintRepo.findById(sprintId.value);
  if (!sprintLoaded.ok) {
    printError(deps, sprintLoaded.error);
    return EXIT_ERROR;
  }
  if (sprintLoaded.value.branch === null) {
    process.stderr.write('error: sprint has no branch — start the sprint with --branch first\n');
    return EXIT_ERROR;
  }

  // Optional body via stdin (`--body -`).
  let body = opts.body;
  if (body === '-') {
    body = await readAllStdin();
  }

  // Pre-load tasks so the deriver can populate the ## Tasks section.
  const tasksResult = await deps.taskRepo.findBySprintId(sprintId.value);
  const tasks = tasksResult.ok ? tasksResult.value : [];

  const flow = createCreatePrFlow(deps, {
    sprintId: sprintId.value,
    cwd: cwd.value,
    base: opts.base ?? 'main',
    draft: opts.draft === true,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(body !== undefined ? { body } : {}),
    tasks,
  });

  const initialCtx: CreatePrCtx = {
    sprintId: sprintId.value,
    cwd: cwd.value,
    base: opts.base ?? 'main',
    draft: opts.draft === true,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(body !== undefined ? { body } : {}),
  };

  return streamSession<CreatePrCtx>({
    sessionManager: deps.sessionManager,
    label: `create-pr ${sprintId.value}`,
    element: flow,
    initialCtx,
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
  }
  return chunks.join('');
}
