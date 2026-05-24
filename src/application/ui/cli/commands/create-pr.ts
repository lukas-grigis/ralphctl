import type { Command } from 'commander';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { createCreatePrFlow } from '@src/application/flows/create-pr/flow.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';

interface Opts {
  readonly sprint: string;
  readonly cwd?: string;
  readonly base: string;
  readonly draft: boolean;
  readonly title?: string;
  readonly body?: string;
  readonly ai: boolean;
}

/**
 * Register the `create-pr` CLI command.
 *
 *   ralphctl create-pr --sprint <id> [--cwd <path>] [--base main]
 *                      [--draft] [--title T] [--body B] [--no-ai]
 *
 * Opens a PR via `gh` / `glab` for the sprint's branch and persists the
 * URL on the sprint execution. `--cwd` defaults to the current working
 * directory; the PR creator runs the platform CLI from there.
 *
 * `--no-ai` skips the optional AI authoring step (default-on) and falls back to the
 * template-derived title + body. The AI step is best-effort — any failure also falls back
 * silently; the flag only matters when the user explicitly wants the template.
 */
export const registerCreatePrCommand = (program: Command): void => {
  program
    .command('create-pr')
    .description("open a PR for the sprint's branch and persist the URL")
    .requiredOption('-s, --sprint <id>', 'sprint id')
    .option('--cwd <path>', 'repository root (defaults to process.cwd())')
    .option('-b, --base <branch>', 'target branch', 'main')
    .option('--draft', 'open as draft', false)
    .option('-t, --title <title>', 'override the derived PR title')
    .option('--body <body>', 'override the derived PR body')
    .option('--no-ai', 'skip AI content generation, use the template only')
    .action(async (opts: Opts) => {
      const cwdInput = opts.cwd ?? process.cwd();
      const cwd = AbsolutePath.parse(cwdInput);
      if (!cwd.ok) {
        process.stderr.write(`error: --cwd: ${cwd.error.message}\n`);
        process.exit(1);
        return;
      }

      const { deps } = await bootstrapCli();
      const flow = createCreatePrFlow(
        {
          sprintRepo: deps.sprintRepo,
          sprintExecutionRepo: deps.sprintExecutionRepo,
          taskRepo: deps.taskRepo,
          pullRequestCreator: deps.pullRequestCreator,
          gitRunner: deps.gitRunner,
          eventBus: deps.eventBus,
          clock: deps.clock,
          provider: deps.provider,
          templateLoader: deps.templateLoader,
          writeFile: deps.writeFile,
          logger: deps.logger,
          // TODO(settings.ai.models.createPr): reuse refine's model until a dedicated
          // create-pr model key + settings migration lands. Easy to grep later.
          model: deps.settings.ai.models.refine,
        },
        { useAi: opts.ai }
      );
      const result = await flow.execute({
        input: {
          sprintId: opts.sprint as SprintId,
          cwd: cwd.value,
          base: opts.base,
          draft: opts.draft,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.body !== undefined ? { body: opts.body } : {}),
        },
      });

      if (!result.ok) {
        process.stderr.write(`error: ${result.error.error.message}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`opened PR ${result.value.ctx.output!.url}\n`);
    });
};
