import { join } from 'node:path';
import type { Command } from 'commander';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createCreatePrFlow } from '@src/application/flows/create-pr/flow.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { pinFallbackNotice, resolveSprintId } from '@src/application/ui/cli/resolve-sprint-selection.ts';

interface Opts {
  readonly sprint?: string;
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
 *   ralphctl create-pr [--sprint <id>] [--cwd <path>] [--base main]
 *                      [--draft] [--title T] [--body B] [--no-ai]
 *
 * Opens a PR via `gh` / `glab` for the sprint's branch and persists the
 * URL on the sprint execution. `--sprint` defaults to the pinned current
 * sprint; `--cwd` defaults to the current working directory; the PR
 * creator runs the platform CLI from there.
 *
 * `--no-ai` skips the optional AI authoring step (default-on) and falls back to the
 * template-derived title + body. The AI step is best-effort — any failure also falls back
 * silently; the flag only matters when the user explicitly wants the template.
 */
export const registerCreatePrCommand = (program: Command): void => {
  program
    .command('create-pr')
    .description("open a PR for the sprint's branch and persist the URL")
    .option('-s, --sprint <id>', 'sprint id (defaults to the current sprint)')
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
      }

      const { deps, storage } = await bootstrapCli();
      const resolved = await resolveSprintId(opts.sprint, storage.stateRoot);
      if (!resolved.ok) {
        process.stderr.write(`error: ${resolved.error.message}\n`);
        process.exit(1);
        return;
      }
      // Opening a PR is a write to the upstream — always disambiguate a pin-derived target.
      if (resolved.value.fromPin) process.stderr.write(pinFallbackNotice(resolved.value.sprintId));
      const sprintId = resolved.value.sprintId;
      const sprintDir = AbsolutePath.parse(join(String(storage.dataRoot), 'sprints', String(sprintId)));
      if (!sprintDir.ok) {
        process.stderr.write(`error: sprint dir: ${sprintDir.error.message}\n`);
        process.exit(1);
      }
      // PATH-gate the AI step: when `--ai` is on (the default), the create-pr AI session spawns
      // the `createPr` row's provider CLI. Probe for it first so a missing binary fails fast with
      // the actionable "binary not found" guidance, matching every other AI flow.
      if (opts.ai) {
        const gate = await checkCli('create-pr', deps.settings);
        if (gate !== undefined && !gate.ok) {
          process.stderr.write(`error: ${gate.reason}\n`);
          process.exit(1);
        }
      }
      // Rebuild the provider from the `createPr` settings row — `deps.provider` is wired from the
      // `implement` row at boot, which mismatches the createPr model in a mixed-provider config.
      const provider = createAiProvider({
        flow: 'createPr',
        ai: deps.settings.ai,
        harnessConfig: deps.settings.harness,
        eventBus: deps.eventBus,
      });
      const flow = createCreatePrFlow(
        {
          sprintRepo: deps.sprintRepo,
          sprintExecutionRepo: deps.sprintExecutionRepo,
          taskRepo: deps.taskRepo,
          pullRequestCreator: deps.pullRequestCreator,
          gitRunner: deps.gitRunner,
          eventBus: deps.eventBus,
          clock: deps.clock,
          provider,
          templateLoader: deps.templateLoader,
          writeFile: deps.writeFile,
          logger: deps.logger,
          model: deps.settings.ai.createPr.model,
        },
        { useAi: opts.ai }
      );
      const result = await flow.execute({
        input: {
          sprintId,
          cwd: cwd.value,
          sprintDir: sprintDir.value,
          base: opts.base,
          draft: opts.draft,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.body !== undefined ? { body: opts.body } : {}),
        },
      });

      if (!result.ok) {
        process.stderr.write(`error: ${result.error.error.message}\n`);
        process.exit(1);
      }
      process.stdout.write(`opened PR ${result.value.ctx.output!.url}\n`);
    });
};
