/**
 * Onboard chain — pre-AI state-loading leaves.
 *
 * Steps covered: load-project → resolve-repo → detect-existing-files
 *
 * These leaves run before any AI session starts: they load the project,
 * resolve the target repository, and probe it for pre-existing AI-context
 * files that would trigger the externally-managed short-circuit path.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';

import type { Project } from '@src/domain/entities/project.ts';
import type { Repository } from '@src/domain/entities/repository.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { ProjectName } from '@src/domain/values/project-name.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import type { LeafUseCase } from '@src/kernel/chain/leaf.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import type { OnboardCtx } from './onboard-flow.ts';
import { HARNESS_MARKER_PREFIX } from './onboard-persist-leaves.ts';

/**
 * Build a leaf whose `output` reducer simply assigns the use-case result
 * to a single field on the context. Replaces the boilerplate
 * `output: (ctx, value) => ({ ...ctx, [outputKey]: value })` pattern used
 * across most onboard leaves.
 *
 * Type-safety: `TKey` is constrained to a key on `OnboardCtx`, and the
 * use-case output must match that field's type — so renaming a context
 * field forces the call site to update.
 */
function makePropLeaf<TKey extends keyof OnboardCtx, UInput>(
  name: string,
  useCase: LeafUseCase<UInput, OnboardCtx[TKey]>,
  input: (ctx: OnboardCtx) => UInput,
  outputKey: TKey
): Element<OnboardCtx> {
  return new Leaf<OnboardCtx, UInput, OnboardCtx[TKey]>(name, {
    useCase,
    input,
    output: (ctx, value) => ({ ...ctx, [outputKey]: value }),
  });
}

/**
 * Files we consider evidence that a repo is already onboarded by some
 * other harness (or hand-authored). Order matters only for display in
 * the prompt — every match contributes to the externally-managed signal.
 */
const PRE_EXISTING_CONTEXT_FILES: readonly string[] = ['CLAUDE.md', '.github/copilot-instructions.md', 'AGENTS.md'];

/**
 * Probe a repo for AI-context files that already exist *without* the
 * ralphctl harness marker. Each match is a signal that the repo is
 * already managed (either by a different harness or hand-authored), so
 * the chain can offer to stamp `onboardedAt` without modifying anything.
 */
async function findExistingContextFiles(repoPath: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const relPath of PRE_EXISTING_CONTEXT_FILES) {
    const fullPath = join(repoPath, relPath);
    let body: string;
    try {
      body = await readFile(fullPath, 'utf-8');
    } catch {
      continue; // file missing — not a signal
    }
    const firstLine = body.split('\n', 1)[0] ?? '';
    if (firstLine.startsWith(HARNESS_MARKER_PREFIX)) {
      // We wrote this file in a previous onboard run — not externally managed.
      continue;
    }
    found.push(relPath);
  }
  return found;
}

// ── load-project ──────────────────────────────────────────────────────

export function loadProjectLeaf(deps: Pick<ChainSharedDeps, 'projectRepo'>): Element<OnboardCtx> {
  return makePropLeaf<'project', { readonly name: ProjectName }>(
    'load-project',
    {
      async execute(input) {
        return deps.projectRepo.findByName(input.name);
      },
    },
    (ctx) => ({ name: ctx.projectName }),
    'project'
  );
}

// ── resolve-repo ──────────────────────────────────────────────────────

/**
 * Pick the repository to onboard. When `ctx.repoPath` is set, it must
 * match an existing repository on the project. When unset, fall through
 * to "the project has exactly one repo" — otherwise fail with
 * `InvalidStateError` so the caller knows it must pre-select.
 */
export function resolveRepoLeaf(): Element<OnboardCtx> {
  return new Leaf<
    OnboardCtx,
    { readonly project: Project; readonly repoPath: AbsolutePath | undefined },
    { readonly repo: Repository; readonly cwd: AbsolutePath }
  >('resolve-repo', {
    useCase: {
      execute(input) {
        const { project, repoPath } = input;
        if (repoPath !== undefined) {
          const match = project.repositories.find((r) => r.path === repoPath);
          if (match === undefined) {
            return Promise.resolve(
              Result.error(
                new InvalidStateError({
                  entity: 'project',
                  currentState: 'unknown-repo',
                  attemptedAction: 'onboard',
                  message: `repository '${String(repoPath)}' not found on project '${String(project.name)}'`,
                })
              )
            );
          }
          return Promise.resolve(Result.ok({ repo: match, cwd: match.path }));
        }
        if (project.repositories.length === 1) {
          const only = project.repositories[0];
          if (only === undefined) {
            // Defensive — length-check above guarantees one exists.
            return Promise.resolve(
              Result.error(
                new InvalidStateError({
                  entity: 'project',
                  currentState: 'no-repo',
                  attemptedAction: 'onboard',
                })
              )
            );
          }
          return Promise.resolve(Result.ok({ repo: only, cwd: only.path }));
        }
        return Promise.resolve(
          Result.error(
            new InvalidStateError({
              entity: 'project',
              currentState: 'multiple-repos',
              attemptedAction: 'onboard',
              message: `project '${String(project.name)}' has multiple repositories — pass --repo to pick one`,
            })
          )
        );
      },
    },
    input: (ctx) => {
      if (!ctx.project) throw new Error('resolve-repo: ctx.project must be loaded first');
      return { project: ctx.project, repoPath: ctx.repoPath };
    },
    output: (ctx, out) => ({ ...ctx, repo: out.repo, cwd: out.cwd }),
  });
}

// ── detect-existing-files ─────────────────────────────────────────────

/**
 * Probe the resolved repo for AI-context files that already exist
 * (without the ralphctl harness marker). When found, prompt the user:
 * mark the repo as externally managed and stamp `onboardedAt` without
 * modifying anything? When the user accepts, the rest of the chain's
 * AI / confirm / write leaves no-op and `save-repo-scripts` only stamps
 * the timestamp. When `autoAccept: true` (--auto / non-interactive), we
 * default to "yes, mark as externally managed" — safer than running the
 * AI write path against a hand-authored file in a CI context.
 */
export function detectExistingFilesLeaf(deps: Pick<ChainSharedDeps, 'prompt' | 'logger'>): Element<OnboardCtx> {
  return new Leaf<
    OnboardCtx,
    { readonly repo: Repository; readonly autoAccept: boolean },
    { readonly externallyManaged: boolean; readonly existingContextFiles: readonly string[] }
  >('detect-existing-files', {
    useCase: {
      async execute(input) {
        const found = await findExistingContextFiles(input.repo.path);
        if (found.length === 0) {
          return Result.ok({ externallyManaged: false, existingContextFiles: [] });
        }

        // In auto mode, treat pre-existing files as the safe default —
        // mark as externally managed, never silently overwrite.
        if (input.autoAccept) {
          deps.logger.info('detect-existing-files: pre-existing files in auto mode — marking externally managed', {
            files: found,
          });
          return Result.ok({ externallyManaged: true, existingContextFiles: found });
        }

        const fileList = found.map((f) => `· ${f}`).join('\n');
        deps.logger.info('detect-existing-files: pre-existing files found', { files: found });
        const accept = await deps.prompt.confirm({
          message: 'This repo already has AI-context files. Mark as onboarded but externally managed?',
          details: fileList,
          default: true,
        });
        return Result.ok({ externallyManaged: accept, existingContextFiles: found });
      },
    },
    input: (ctx) => {
      if (!ctx.repo) throw new Error('detect-existing-files: ctx.repo must be resolved first');
      return { repo: ctx.repo, autoAccept: ctx.autoAccept };
    },
    output: (ctx, out) => ({
      ...ctx,
      externallyManaged: out.externallyManaged,
      existingContextFiles: out.existingContextFiles,
    }),
  });
}
