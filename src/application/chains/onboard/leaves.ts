/**
 * Onboard chain leaves — the workflow-specific glue between the
 * `OnboardRepoUseCase` round-trip and the project / repository
 * persistence layer.
 *
 * The leaves intentionally live together (one cohesive module) instead
 * of one-leaf-per-file because every leaf shares the same `OnboardCtx`
 * and the same set of imports — a leaf-per-file split would just be
 * boilerplate. The flow factory imports the named leaves from here.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Result } from 'typescript-result';

import type { Project } from '../../../domain/entities/project.ts';
import type { Repository } from '../../../domain/entities/repository.ts';
import { InvalidStateError } from '../../../domain/errors/invalid-state-error.ts';
import { StorageError } from '../../../domain/errors/storage-error.ts';
import type { ValidationError } from '../../../domain/values/validation-error.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import type { ProjectName } from '../../../domain/values/project-name.ts';
import type { Element } from '../../../kernel/chain/element.ts';
import type { LeafUseCase } from '../../../kernel/chain/leaf.ts';
import { Leaf } from '../../../kernel/chain/leaf.ts';
import {
  contextFilePathFor,
  OnboardRepoUseCase,
  type OnboardRepoProposals,
} from '../../../business/usecases/onboard/onboard-repo.ts';
import type { ChainSharedDeps } from '../chain-deps.ts';
import type { OnboardCtx } from './onboard-flow.ts';

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
 * Sentinel marker the harness injects on the first line of a written
 * project context file. A future onboarding pass that finds this marker
 * picks `update` mode (full replacement allowed); without it the file
 * is treated as user-authored and `adopt` mode preserves the body.
 */
const HARNESS_MARKER_PREFIX = '<!-- ralphctl onboard:';

function makeMarker(now: () => Date = () => new Date()): string {
  return `${HARNESS_MARKER_PREFIX} ${now().toISOString()} -->`;
}

// ── load-project ─────────────────────────────────────────────────────

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

// ── resolve-repo ─────────────────────────────────────────────────────

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

// ── run-onboard-ai ───────────────────────────────────────────────────

/**
 * Drive the read-only AI inventory pass. Mode is detected by probing
 * the existing project context file: harness-marker present → `update`,
 * authored body → `adopt`, missing → `bootstrap`.
 */
export function runOnboardAiLeaf(
  deps: Pick<ChainSharedDeps, 'aiSession' | 'prompts' | 'signalParser' | 'logger'>
): Element<OnboardCtx> {
  const useCase = new OnboardRepoUseCase(deps.aiSession, deps.prompts, deps.signalParser, deps.logger);
  return makePropLeaf<
    'proposals',
    { readonly project: Project; readonly repo: Repository; readonly cwd: AbsolutePath }
  >(
    'run-onboard-ai',
    {
      async execute(input) {
        await deps.aiSession.ensureReady();
        const provider = deps.aiSession.getProviderName();
        const fileName = contextFilePathFor(provider);
        const targetPath = join(input.repo.path, fileName);

        const detected = await detectModeAndBody(targetPath);

        return useCase.execute({
          project: input.project,
          repo: input.repo,
          cwd: input.cwd,
          mode: detected.mode,
          aiProvider: provider,
          ...(input.repo.checkScript !== undefined ? { checkScriptSuggestion: input.repo.checkScript } : {}),
          ...(detected.body !== undefined ? { existingAgentsMd: detected.body } : {}),
        });
      },
    },
    (ctx) => {
      if (!ctx.project) throw new Error('run-onboard-ai: ctx.project must be loaded first');
      if (!ctx.repo) throw new Error('run-onboard-ai: ctx.repo must be resolved first');
      if (!ctx.cwd) throw new Error('run-onboard-ai: ctx.cwd must be set first');
      return { project: ctx.project, repo: ctx.repo, cwd: ctx.cwd };
    },
    'proposals'
  );
}

interface DetectedMode {
  readonly mode: 'bootstrap' | 'adopt' | 'update';
  readonly body: string | undefined;
}

async function detectModeAndBody(targetPath: string): Promise<DetectedMode> {
  let body: string;
  try {
    body = await readFile(targetPath, 'utf-8');
  } catch {
    return { mode: 'bootstrap', body: undefined };
  }
  const firstLine = body.split('\n', 1)[0] ?? '';
  if (firstLine.startsWith(HARNESS_MARKER_PREFIX)) {
    return { mode: 'update', body };
  }
  return { mode: 'adopt', body };
}

// ── confirm-setup-script ─────────────────────────────────────────────

export function confirmSetupScriptLeaf(deps: Pick<ChainSharedDeps, 'prompt'>): Element<OnboardCtx> {
  return makePropLeaf<
    'acceptedSetupScript',
    { readonly proposals: OnboardRepoProposals; readonly autoAccept: boolean }
  >(
    'confirm-setup-script',
    {
      async execute(input) {
        if (input.autoAccept) {
          return Result.ok(input.proposals.setupScript);
        }
        const value = await deps.prompt.input({
          message: 'Setup script (Enter to accept, edit to change, empty to skip)',
          default: input.proposals.setupScript ?? '',
        });
        const trimmed = value.trim();
        return Result.ok(trimmed.length === 0 ? null : trimmed);
      },
    },
    (ctx) => {
      if (!ctx.proposals) throw new Error('confirm-setup-script: ctx.proposals must be set first');
      return { proposals: ctx.proposals, autoAccept: ctx.autoAccept };
    },
    'acceptedSetupScript'
  );
}

// ── confirm-verify-script ────────────────────────────────────────────

export function confirmVerifyScriptLeaf(deps: Pick<ChainSharedDeps, 'prompt'>): Element<OnboardCtx> {
  return makePropLeaf<
    'acceptedVerifyScript',
    { readonly proposals: OnboardRepoProposals; readonly autoAccept: boolean }
  >(
    'confirm-verify-script',
    {
      async execute(input) {
        if (input.autoAccept) {
          return Result.ok(input.proposals.verifyScript);
        }
        const value = await deps.prompt.input({
          message: 'Verify script (Enter to accept, edit to change, empty to skip)',
          default: input.proposals.verifyScript ?? '',
        });
        const trimmed = value.trim();
        return Result.ok(trimmed.length === 0 ? null : trimmed);
      },
    },
    (ctx) => {
      if (!ctx.proposals) throw new Error('confirm-verify-script: ctx.proposals must be set first');
      return { proposals: ctx.proposals, autoAccept: ctx.autoAccept };
    },
    'acceptedVerifyScript'
  );
}

// ── confirm-context-file ─────────────────────────────────────────────

export function confirmContextFileLeaf(deps: Pick<ChainSharedDeps, 'prompt'>): Element<OnboardCtx> {
  return makePropLeaf<
    'acceptedContextFile',
    { readonly proposals: OnboardRepoProposals; readonly autoAccept: boolean }
  >(
    'confirm-context-file',
    {
      async execute(input) {
        if (input.autoAccept) {
          return Result.ok(input.proposals.contextFileContent);
        }
        // Editor returns null on cancel — treat as "skip write".
        const edited = await deps.prompt.editor({
          message: `Project context file (${input.proposals.contextFilePath})`,
          default: input.proposals.contextFileContent ?? '',
          kind: 'markdown',
        });
        if (edited === null) return Result.ok(null);
        return Result.ok(edited.length === 0 ? null : edited);
      },
    },
    (ctx) => {
      if (!ctx.proposals) throw new Error('confirm-context-file: ctx.proposals must be set first');
      return { proposals: ctx.proposals, autoAccept: ctx.autoAccept };
    },
    'acceptedContextFile'
  );
}

// ── write-context-file ───────────────────────────────────────────────

/**
 * Write the accepted body to the provider-native context file path.
 * Skipped (no-op) when nothing was accepted. Injects a harness marker
 * on the first line so subsequent runs detect `update` mode.
 *
 * `now` is injectable for testability.
 */
export function writeContextFileLeaf(now: () => Date = () => new Date()): Element<OnboardCtx> {
  return new Leaf<
    OnboardCtx,
    {
      readonly repo: Repository;
      readonly proposals: OnboardRepoProposals;
      readonly accepted: string | null | undefined;
    },
    void
  >('write-context-file', {
    useCase: {
      async execute(input) {
        const { repo, proposals, accepted } = input;
        if (accepted === null || accepted === undefined || accepted.length === 0) {
          // Nothing to write — leaf still completes so the trace records it.
          return Result.ok(undefined);
        }
        const targetPath = join(repo.path, proposals.contextFilePath);
        try {
          await mkdir(dirname(targetPath), { recursive: true });
          const marker = makeMarker(now);
          // Prepend the marker if the body didn't already start with one.
          const firstLine = accepted.split('\n', 1)[0] ?? '';
          const body = firstLine.startsWith(HARNESS_MARKER_PREFIX) ? accepted : `${marker}\n${accepted}`;
          await writeFile(targetPath, body, 'utf-8');
          return Result.ok(undefined);
        } catch (err) {
          return Result.error(
            new StorageError({
              subCode: 'io',
              message: `failed to write project context file at ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
              path: targetPath,
              cause: err,
            })
          );
        }
      },
    },
    input: (ctx) => {
      if (!ctx.repo) throw new Error('write-context-file: ctx.repo must be set first');
      if (!ctx.proposals) throw new Error('write-context-file: ctx.proposals must be set first');
      return { repo: ctx.repo, proposals: ctx.proposals, accepted: ctx.acceptedContextFile };
    },
    output: (ctx) => ctx,
  });
}

// ── save-repo-scripts ────────────────────────────────────────────────

/**
 * Persist the accepted setup + verify scripts onto the repository, and
 * stamp `onboardedAt` so status surfaces (TUI / CLI / doctor) can answer
 * "is this repo onboarded yet?". `verifyScript` lives on
 * `Repository.checkScript` (single field, single runner). `setupScript`
 * is its own field. `now` is injectable for stable timestamps in tests.
 */
export function saveRepoScriptsLeaf(
  deps: Pick<ChainSharedDeps, 'projectRepo'>,
  now: () => IsoTimestamp = () => IsoTimestamp.now()
): Element<OnboardCtx> {
  return new Leaf<
    OnboardCtx,
    {
      readonly project: Project;
      readonly repo: Repository;
      readonly setupScript: string | null | undefined;
      readonly verifyScript: string | null | undefined;
    },
    void
  >('save-repo-scripts', {
    useCase: {
      async execute(input) {
        // null → clear; undefined → leave unchanged.
        const setupArg = applyAcceptance(input.setupScript, input.repo.setupScript);
        const verifyArg = applyAcceptance(input.verifyScript, input.repo.checkScript);

        const updateA = input.project.updateRepository(input.repo.path, { setupScript: setupArg.value });
        if (!updateA.ok) return Result.error(unwrapValidationError(updateA.error));

        const updateB = updateA.value.updateRepository(input.repo.path, { checkScript: verifyArg.value });
        if (!updateB.ok) return Result.error(unwrapValidationError(updateB.error));

        const updateC = updateB.value.updateRepository(input.repo.path, { onboardedAt: now() });
        if (!updateC.ok) return Result.error(unwrapValidationError(updateC.error));

        const saved = await deps.projectRepo.save(updateC.value);
        if (!saved.ok) return Result.error(saved.error);
        return Result.ok(undefined);
      },
    },
    input: (ctx) => {
      if (!ctx.project) throw new Error('save-repo-scripts: ctx.project must be set first');
      if (!ctx.repo) throw new Error('save-repo-scripts: ctx.repo must be set first');
      return {
        project: ctx.project,
        repo: ctx.repo,
        setupScript: ctx.acceptedSetupScript,
        verifyScript: ctx.acceptedVerifyScript,
      };
    },
    output: (ctx) => ctx,
  });
}

/**
 * Map the chain's three-state acceptance (string | null | undefined) onto
 * the entity's `withXxxScript(string | undefined)` signature.
 *
 *  - `string` (non-empty) → set the field to that value
 *  - `null`               → explicitly clear (set to undefined)
 *  - `undefined`          → leave the existing value unchanged
 */
function applyAcceptance(
  accepted: string | null | undefined,
  existing: string | undefined
): { readonly value: string | undefined } {
  if (accepted === undefined) return { value: existing };
  if (accepted === null) return { value: undefined };
  return { value: accepted };
}

function unwrapValidationError(err: ValidationError): ValidationError {
  return err;
}
