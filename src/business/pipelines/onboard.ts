/**
 * `project onboard` pipeline — per-repo project context file bootstrapping.
 *
 * Happy path:
 *   load-project → select-repo → repo-preflight → ai-inventory →
 *   validate-agents-md → retry-agents-md-on-violation → check-drift →
 *   review-and-confirm → write-artifacts → verify-check-script
 *
 * No sprint context is threaded — the pipeline uses the base `StepContext`
 * with an empty `sprintId`. Every onboard-specific field rides on the
 * extended `OnboardContext`.
 */

import type { StepContext } from '@src/domain/context.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { ParseError, ProjectNotFoundError } from '@src/domain/errors.ts';
import { CURRENT_ONBOARDING_VERSION, type AiProvider, type Project, type Repository } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { PromptPort } from '@src/business/ports/prompt.ts';
import type { LintViolation, OnboardAdapterPort } from '@src/business/ports/onboard-adapter.ts';
import { pipeline, step } from '@src/business/pipelines/framework/helpers.ts';
import { validateAgentsMdStep } from '@src/business/pipelines/steps/validate-agents-md.ts';

/**
 * Provider-native project context file name (display / AI prompt).
 * Pure: mirrors the path logic in `agents-md-writer.ts` without coupling the
 * business layer to the filesystem adapter.
 */
function providerInstructionsFileName(provider: AiProvider): string {
  if (provider === 'claude') return 'CLAUDE.md';
  return '.github/copilot-instructions.md';
}

export type OnboardMode = 'bootstrap' | 'adopt' | 'update';

export interface OnboardContext extends StepContext {
  projectName: string;
  project?: Project;
  provider?: AiProvider;
  repo?: Repository;
  mode?: OnboardMode;
  existingAgentsMd?: string | null;
  agentsMdDraft?: string;
  agentsMdViolations?: LintViolation[];
  agentsMdFinal?: string;
  checkScriptDraft?: string | null;
  checkScriptFinal?: string | null;
  changes?: string | null;
  driftWarnings?: string[];
  alreadyCurrent?: boolean;
  writtenPath?: string;
}

export interface OnboardOptions {
  repo?: string;
  dryRun?: boolean;
  auto?: boolean;
}

/**
 * Persistence hook for writing the updated project back after onboarding.
 * Business code can't call the file-backed `updateProject` directly, so the
 * composition root injects this function. Signature mirrors
 * `updateProject(name, { repositories })`.
 */
export type UpdateProjectRepos = (projectName: string, repositories: Repository[]) => Promise<Project>;

export interface OnboardDeps {
  persistence: PersistencePort;
  adapter: OnboardAdapterPort;
  logger: LoggerPort;
  prompt: PromptPort;
  updateProjectRepos: UpdateProjectRepos;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function loadProjectStep(deps: OnboardDeps) {
  return step<OnboardContext>('load-project', async (ctx): Promise<DomainResult<Partial<OnboardContext>>> => {
    try {
      const project = await deps.persistence.getProject(ctx.projectName);
      const config = await deps.persistence.getConfig();
      if (!config.aiProvider) {
        return Result.error(
          new ParseError(
            'No AI provider configured — run `ralphctl config set provider <claude|copilot>` before onboarding.'
          )
        );
      }
      const partial: Partial<OnboardContext> = { project, provider: config.aiProvider };
      return Result.ok(partial) as DomainResult<Partial<OnboardContext>>;
    } catch (err) {
      if (err instanceof ProjectNotFoundError) return Result.error(err);
      return Result.error(new ParseError(err instanceof Error ? err.message : String(err)));
    }
  });
}

function selectRepoStep(deps: OnboardDeps, options: OnboardOptions) {
  return step<OnboardContext>('select-repo', async (ctx): Promise<DomainResult<Partial<OnboardContext>>> => {
    const project = ctx.project;
    if (!project) return Result.error(new ParseError('Project not loaded.'));
    const repos = project.repositories;
    if (repos.length === 0) return Result.error(new ParseError('Project has no repositories.'));

    if (options.repo) {
      const match = repos.find((r) => r.name === options.repo);
      if (!match) {
        return Result.error(new ParseError(`No repository named "${options.repo}" in project "${project.name}".`));
      }
      return Result.ok({ repo: match }) as DomainResult<Partial<OnboardContext>>;
    }

    if (repos.length === 1) {
      const only = repos[0];
      if (!only) return Result.error(new ParseError('Project has no repositories.'));
      return Result.ok({ repo: only }) as DomainResult<Partial<OnboardContext>>;
    }

    if (options.auto) {
      // Without an explicit --repo, auto mode picks the first repo. Bulk
      // onboarding is a non-goal; callers wanting every repo should loop.
      const first = repos[0];
      if (!first) return Result.error(new ParseError('Project has no repositories.'));
      return Result.ok({ repo: first }) as DomainResult<Partial<OnboardContext>>;
    }

    const choice = await deps.prompt.select<string>({
      message: `Select a repository to onboard in "${project.name}":`,
      choices: repos.map((r) => ({ label: `${r.name} — ${r.path}`, value: r.id })),
    });
    const selected = repos.find((r) => r.id === choice);
    if (!selected) return Result.error(new ParseError('Invalid repository selection.'));
    return Result.ok({ repo: selected }) as DomainResult<Partial<OnboardContext>>;
  });
}

function repoPreflightStep(deps: OnboardDeps) {
  return step<OnboardContext>('repo-preflight', (ctx): DomainResult<Partial<OnboardContext>> => {
    const repo = ctx.repo;
    const provider = ctx.provider;
    if (!repo) return Result.error(new ParseError('Repository not resolved.'));
    if (!provider) return Result.error(new ParseError('AI provider not resolved.'));
    const validation = deps.adapter.validateRepoPath(repo.path);
    if (!validation.exists) {
      return Result.error(new ParseError(`Repository path does not exist or is not a directory: ${repo.path}`));
    }
    if (!validation.isGitRepo) {
      return Result.error(new ParseError(`Repository is not a git repository: ${repo.path}`));
    }

    const existing = deps.adapter.readExistingInstructions(repo.path, provider);
    let mode: OnboardMode;
    if (existing.content === null) {
      mode = 'bootstrap';
    } else if (repo.onboardingVersion != null) {
      mode = 'update';
    } else {
      mode = 'adopt';
    }

    const partial: Partial<OnboardContext> = {
      mode,
      existingAgentsMd: existing.content,
    };
    return Result.ok(partial) as DomainResult<Partial<OnboardContext>>;
  });
}

function aiInventoryStep(deps: OnboardDeps) {
  return step<OnboardContext>('ai-inventory', async (ctx): Promise<DomainResult<Partial<OnboardContext>>> => {
    const repo = ctx.repo;
    const mode = ctx.mode;
    const provider = ctx.provider;
    if (!repo || !mode || !provider)
      return Result.error(new ParseError('Preflight did not populate repo/mode/provider.'));

    deps.logger.info(`Asking AI to inventory ${repo.name}...`);
    let result;
    try {
      result = await deps.adapter.discoverAgentsMd({
        repoPath: repo.path,
        mode,
        existingAgentsMd: ctx.existingAgentsMd ?? null,
        projectType: deps.adapter.inferProjectType(repo.path),
        checkScriptSuggestion: repo.checkScript ?? '',
        fileName: providerInstructionsFileName(provider),
      });
    } catch (err) {
      return Result.error(new ParseError(`AI inventory failed: ${err instanceof Error ? err.message : String(err)}`));
    }

    if (!result.agentsMd) {
      return Result.error(
        new ParseError('AI returned no project context file proposal — try again, or edit the file manually.')
      );
    }

    const partial: Partial<OnboardContext> = {
      agentsMdDraft: result.agentsMd,
      checkScriptDraft: result.checkScript,
      changes: result.changes,
    };
    return Result.ok(partial) as DomainResult<Partial<OnboardContext>>;
  });
}

function retryOnViolationStep(deps: OnboardDeps) {
  return step<OnboardContext>(
    'retry-agents-md-on-violation',
    async (ctx): Promise<DomainResult<Partial<OnboardContext>>> => {
      const violations = ctx.agentsMdViolations ?? [];
      if (violations.length === 0) return Result.ok({}) as DomainResult<Partial<OnboardContext>>;

      const repo = ctx.repo;
      const mode = ctx.mode;
      const provider = ctx.provider;
      const draft = ctx.agentsMdDraft;
      if (!repo || !mode || !provider || !draft) {
        return Result.error(new ParseError('Retry requires repo, mode, provider, and an existing draft.'));
      }

      deps.logger.warn(
        `Project context file draft failed ${String(violations.length)} rule(s); asking AI for a fix...`
      );
      const violationSummary = violations.map((v) => `- [${v.rule}] ${v.message}`).join('\n');
      const feedbackContext = [
        ctx.existingAgentsMd ?? '',
        '',
        '---',
        '',
        'Your previous draft (below) violated these rules:',
        violationSummary,
        '',
        'Fix every violation and re-emit the full project context file plus check-script.',
        '',
        draft,
      ].join('\n');

      let retry;
      try {
        retry = await deps.adapter.discoverAgentsMd({
          repoPath: repo.path,
          mode,
          existingAgentsMd: feedbackContext,
          projectType: deps.adapter.inferProjectType(repo.path),
          checkScriptSuggestion: ctx.checkScriptDraft ?? repo.checkScript ?? '',
          fileName: providerInstructionsFileName(provider),
        });
      } catch (err) {
        return Result.error(new ParseError(`Retry failed: ${err instanceof Error ? err.message : String(err)}`));
      }

      if (!retry.agentsMd) {
        deps.logger.warn('Retry produced no new proposal — keeping original draft.');
        return Result.ok({}) as DomainResult<Partial<OnboardContext>>;
      }

      const { violations: retryViolations } = deps.adapter.lintAgentsMd(retry.agentsMd);
      const partial: Partial<OnboardContext> = {
        agentsMdDraft: retry.agentsMd,
        checkScriptDraft: retry.checkScript ?? ctx.checkScriptDraft,
        agentsMdViolations: retryViolations,
      };
      return Result.ok(partial) as DomainResult<Partial<OnboardContext>>;
    }
  );
}

function checkDriftStep(deps: OnboardDeps) {
  return step<OnboardContext>('check-drift', (ctx): DomainResult<Partial<OnboardContext>> => {
    const draft = ctx.agentsMdDraft;
    const repo = ctx.repo;
    if (!draft || !repo) return Result.error(new ParseError('check-drift requires a draft and repo.'));

    const warnings = deps.adapter.detectCommandDrift(draft, repo.path);
    // Surface any lint violations that survived the retry so the user sees them
    // in the result card (CLI + TUI). Without this the draft can ship invalid
    // in --auto mode, because `review-and-confirm` skips the interactive
    // editor.
    const residual = ctx.agentsMdViolations ?? [];
    for (const v of residual) {
      warnings.push(`lint[${v.rule}]: ${v.message}`);
    }
    const alreadyCurrent =
      ctx.mode === 'update' && warnings.length === 0 && (!ctx.changes || ctx.changes.trim().length === 0);

    const partial: Partial<OnboardContext> = {
      driftWarnings: warnings,
      alreadyCurrent,
    };
    return Result.ok(partial) as DomainResult<Partial<OnboardContext>>;
  });
}

function reviewAndConfirmStep(deps: OnboardDeps, options: OnboardOptions) {
  return step<OnboardContext>('review-and-confirm', async (ctx): Promise<DomainResult<Partial<OnboardContext>>> => {
    if (ctx.alreadyCurrent || options.auto || options.dryRun) {
      const partial: Partial<OnboardContext> = {
        agentsMdFinal: ctx.agentsMdDraft,
        checkScriptFinal: ctx.checkScriptDraft ?? null,
      };
      return Result.ok(partial) as DomainResult<Partial<OnboardContext>>;
    }

    const fileName = ctx.provider ? providerInstructionsFileName(ctx.provider) : 'project context file';
    const edited = await deps.prompt.editor({
      message: `Review ${fileName} (save to accept, cancel to abort):`,
      default: ctx.agentsMdDraft ?? '',
    });
    if (edited === null) {
      return Result.error(new ParseError('User cancelled project context file review.'));
    }

    const checkEdited = await deps.prompt.input({
      message: 'Check script (optional; empty skips):',
      default: ctx.checkScriptDraft ?? '',
    });
    const finalCheck = checkEdited.trim() === '' ? null : checkEdited.trim();

    const partial: Partial<OnboardContext> = {
      agentsMdFinal: edited,
      checkScriptFinal: finalCheck,
    };
    return Result.ok(partial) as DomainResult<Partial<OnboardContext>>;
  });
}

function writeArtifactsStep(deps: OnboardDeps, options: OnboardOptions) {
  return step<OnboardContext>('write-artifacts', async (ctx): Promise<DomainResult<Partial<OnboardContext>>> => {
    if (options.dryRun || ctx.alreadyCurrent) {
      deps.logger.info(options.dryRun ? 'Dry run — skipping writes.' : 'Already up to date — skipping writes.');
      return Result.ok({}) as DomainResult<Partial<OnboardContext>>;
    }
    const repo = ctx.repo;
    const project = ctx.project;
    const provider = ctx.provider;
    const content = ctx.agentsMdFinal;
    if (!repo || !project || !provider || !content) {
      return Result.error(new ParseError('write-artifacts requires repo, project, provider, and final content.'));
    }

    // Adopt mode — authored file exists and must not be replaced. The AI
    // emits additions only, so overwriting would destroy the user's prose.
    // Skip the write and surface the proposal through `driftWarnings` so
    // the CLI/TUI result card shows it and the user can apply the additions
    // by hand. Bumping `onboardingVersion` now would lie about what's on
    // disk, so we leave the marker untouched.
    if (ctx.mode === 'adopt') {
      deps.logger.warn(
        'Adopt mode — existing project context file left untouched. Review the proposed additions and apply them manually.'
      );
      return Result.ok({
        driftWarnings: [
          ...(ctx.driftWarnings ?? []),
          'adopt-mode: authored file preserved; proposed additions not written — apply manually.',
        ],
      }) as DomainResult<Partial<OnboardContext>>;
    }

    try {
      const written = deps.adapter.writeProviderInstructions(repo.path, content, provider);

      // Persist updated repo metadata: bump version + save resolved check script.
      const updatedRepos: Repository[] = project.repositories.map((r) => {
        if (r.id !== repo.id) return r;
        const next: Repository = {
          ...r,
          onboardingVersion: CURRENT_ONBOARDING_VERSION,
        };
        const cs = ctx.checkScriptFinal;
        if (cs && cs.length > 0) {
          next.checkScript = cs;
        } else if (cs === null) {
          delete next.checkScript;
        }
        return next;
      });
      await deps.updateProjectRepos(project.name, updatedRepos);

      const partial: Partial<OnboardContext> = {
        writtenPath: written.path,
      };
      return Result.ok(partial) as DomainResult<Partial<OnboardContext>>;
    } catch (err) {
      return Result.error(new ParseError(`Write failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  });
}

function verifyCheckScriptStep(deps: OnboardDeps) {
  return step<OnboardContext>('verify-check-script', (ctx): DomainResult<Partial<OnboardContext>> => {
    const cmd = ctx.checkScriptFinal;
    if (!cmd) return Result.ok({}) as DomainResult<Partial<OnboardContext>>;
    if (!/^\S/.test(cmd)) {
      deps.logger.warn(`Check script looks malformed: ${cmd}`);
    }
    return Result.ok({}) as DomainResult<Partial<OnboardContext>>;
  });
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export function createOnboardPipeline(deps: OnboardDeps, options: OnboardOptions = {}) {
  return pipeline<OnboardContext>('onboard', [
    loadProjectStep(deps),
    selectRepoStep(deps, options),
    repoPreflightStep(deps),
    aiInventoryStep(deps),
    validateAgentsMdStep<OnboardContext>(deps.adapter),
    retryOnViolationStep(deps),
    checkDriftStep(deps),
    reviewAndConfirmStep(deps, options),
    writeArtifactsStep(deps, options),
    verifyCheckScriptStep(deps),
  ]);
}
