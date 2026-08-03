import type { Command } from 'commander';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
import { createCreatePrFlow } from '@src/application/flows/create-pr/flow.ts';
import type { CreatePrCtx } from '@src/application/flows/create-pr/ctx.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createSkillsAdapter } from '@src/integration/ai/skills/adapter-factory.ts';
import { buildComposedSkillSource } from '@src/application/ui/shared/launcher.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';
import { pinFallbackNotice, resolveSprintId } from '@src/application/ui/cli/resolve-sprint-selection.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import type { Element } from '@src/application/chain/element.ts';

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
 * Build the createPr provider + composed skill source + flow. Extracted from the command action
 * to keep it under the per-function line budget. The skill source is composed directly (not via
 * `launchFlow` — this command never reaches that dispatch, see `flowMountsSkills`'s doc comment)
 * with a project-less snapshot: a one-shot PR-summary spawn over an already-pushed diff has no
 * use for the project-scoped (detect-skills) source.
 */
const buildCreatePrFlow = (deps: AppDeps, storage: StoragePaths, useAi: boolean): Element<CreatePrCtx> => {
  // Rebuild the provider from the `createPr` settings row — `deps.provider` is wired from the
  // `implement` row at boot, which mismatches the createPr model in a mixed-provider config.
  const resolvedProvider = deps.settings.ai.createPr.provider;
  const provider = createAiProvider({
    flow: 'createPr',
    ai: deps.settings.ai,
    harnessConfig: deps.settings.harness,
    eventBus: deps.eventBus,
  });
  const skillSource = buildComposedSkillSource(
    { app: deps, storage },
    {},
    resolvedProvider,
    'create-pr',
    deps.settings,
    {}
  );
  const skillsAdapter = createSkillsAdapter({ provider: resolvedProvider, logger: deps.logger });
  return createCreatePrFlow(
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
      skillSource,
      skillsAdapter,
    },
    { useAi }
  );
};

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
const createPrAction = async (opts: Opts): Promise<void> => {
  const cwdInput = opts.cwd ?? process.cwd();
  const cwd = AbsolutePath.parse(cwdInput);
  if (!cwd.ok) {
    fail(`--cwd: ${cwd.error.message}`);
    return;
  }

  const { deps, storage } = await bootstrapCli();
  const resolved = await resolveSprintId(opts.sprint, storage.stateRoot);
  if (!resolved.ok) {
    fail(resolved.error.message);
    return;
  }
  // Opening a PR is a write to the upstream — always disambiguate a pin-derived target.
  if (resolved.value.fromPin) process.stderr.write(pinFallbackNotice(resolved.value.sprintId));
  const sprintId = resolved.value.sprintId;
  // PATH-gate the AI step FIRST: when `--ai` is on (the default), the create-pr AI session
  // spawns the `createPr` row's provider CLI. Probe for it before any sprint I/O so a missing
  // binary fails fast with the actionable "binary not found" guidance, matching every other
  // AI flow (and so the gate cannot be masked by a not-yet-materialised sprint dir).
  if (opts.ai) {
    const gate = await checkCli('create-pr', deps.settings);
    if (gate !== undefined && !gate.ok) {
      fail(gate.reason);
      return;
    }
  }
  // Resolve the sprint dir via the tolerant id-prefix resolver (both `<id>--<slug>/` and the
  // legacy bare `<id>/`); the command only holds the sprint id, not the entity.
  const resolvedDir = await resolveSprintDir(storage.dataRoot, sprintId);
  if (resolvedDir === undefined) {
    fail('sprint dir: not found on disk');
    return;
  }
  const sprintDir = AbsolutePath.parse(resolvedDir);
  if (!sprintDir.ok) {
    fail(`sprint dir: ${sprintDir.error.message}`);
    return;
  }
  const flow = buildCreatePrFlow(deps, storage, opts.ai);
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
    fail(result.error.error.message);
    return;
  }
  process.stdout.write(`opened PR ${result.value.ctx.output!.url}\n`);
};

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
    .action(createPrAction);
};
