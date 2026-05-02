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
import { Result } from '@src/domain/result.ts';

import type { Project } from '@src/domain/entities/project.ts';
import type { Repository } from '@src/domain/entities/repository.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import type { ValidationError } from '@src/domain/values/validation-error.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { ProjectName } from '@src/domain/values/project-name.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import type { LeafUseCase } from '@src/kernel/chain/leaf.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import {
  contextFilePathFor,
  OnboardRepoUseCase,
  type OnboardRepoProposals,
} from '@src/business/usecases/onboard/onboard-repo.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
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

// ── confirm-start-ai ─────────────────────────────────────────────────

/**
 * Pre-confirm before launching the AI inventory pass. Refine has the
 * same gate per ticket; onboard had nothing equivalent — the AI
 * session would start as soon as the user clicked "Onboard repo",
 * potentially burning credits before they realised what was about to
 * happen. Skipped when `externallyManaged` was already accepted in
 * `detect-existing-files`, or when `autoAccept: true` (--auto / CI).
 *
 * Decline → set `externallyManaged: true` so the rest of the chain
 * short-circuits like the externally-managed path. Repo is stamped as
 * onboarded, no AI session runs, no files are written.
 */
export function confirmStartAiLeaf(
  deps: Pick<ChainSharedDeps, 'aiSession' | 'prompt' | 'logger'>
): Element<OnboardCtx> {
  return new Leaf<
    OnboardCtx,
    { readonly repo: Repository; readonly autoAccept: boolean; readonly externallyManaged: boolean },
    boolean
  >('confirm-start-ai', {
    useCase: {
      async execute(input) {
        // Externally managed (already decided) or auto mode → skip the gate.
        if (input.externallyManaged || input.autoAccept) {
          return Result.ok(input.externallyManaged);
        }
        await deps.aiSession.ensureReady();
        const provider = deps.aiSession.getProviderDisplayName();
        const proceed = await deps.prompt.confirm({
          message: `Start ${provider} repo-inventory session for ${input.repo.name}?`,
          default: true,
        });
        if (!proceed) {
          deps.logger.info('onboard: user declined AI inventory — marking externally managed');
          return Result.ok(true); // externallyManaged
        }
        return Result.ok(false);
      },
    },
    input: (ctx) => {
      if (!ctx.repo) throw new Error('confirm-start-ai: ctx.repo must be resolved first');
      return {
        repo: ctx.repo,
        autoAccept: ctx.autoAccept,
        externallyManaged: ctx.externallyManaged === true,
      };
    },
    output: (ctx, externallyManaged) => ({ ...ctx, externallyManaged }),
  });
}

// ── detect-existing-files ────────────────────────────────────────────

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
  return new Leaf<
    OnboardCtx,
    {
      readonly project: Project;
      readonly repo: Repository;
      readonly cwd: AbsolutePath;
      readonly externallyManaged: boolean;
    },
    OnboardRepoProposals | undefined
  >('run-onboard-ai', {
    useCase: {
      async execute(input) {
        if (input.externallyManaged) {
          // Externally managed → no AI round-trip, no proposals.
          return Result.ok(undefined);
        }
        await deps.aiSession.ensureReady();
        const provider = deps.aiSession.getProviderName();
        const fileName = contextFilePathFor(provider);
        const targetPath = join(input.repo.path, fileName);

        const detected = await detectModeAndBody(targetPath);

        const result = await useCase.execute({
          project: input.project,
          repo: input.repo,
          cwd: input.cwd,
          mode: detected.mode,
          aiProvider: provider,
          ...(input.repo.checkScript !== undefined ? { checkScriptSuggestion: input.repo.checkScript } : {}),
          ...(detected.body !== undefined ? { existingAgentsMd: detected.body } : {}),
        });
        if (!result.ok) return Result.error(result.error);
        return Result.ok(result.value);
      },
    },
    input: (ctx) => {
      if (!ctx.project) throw new Error('run-onboard-ai: ctx.project must be loaded first');
      if (!ctx.repo) throw new Error('run-onboard-ai: ctx.repo must be resolved first');
      if (!ctx.cwd) throw new Error('run-onboard-ai: ctx.cwd must be set first');
      return {
        project: ctx.project,
        repo: ctx.repo,
        cwd: ctx.cwd,
        externallyManaged: ctx.externallyManaged === true,
      };
    },
    output: (ctx, value) => ({ ...ctx, ...(value !== undefined ? { proposals: value } : {}) }),
  });
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

/**
 * Prompt for a script value with the AI's suggestion pre-filled. Loops
 * until the user supplies a non-empty value — onboarding requires
 * concrete commands, not stub fields. Empty input falls back to the
 * suggestion when one exists; otherwise re-prompts with a hint.
 */
async function promptRequiredScript(
  prompt: ChainSharedDeps['prompt'],
  message: string,
  suggestion: string | null
): Promise<string> {
  const defaultValue = suggestion ?? '';
  let hint: string | null = null;
  for (;;) {
    const fullMessage = hint !== null ? `${message} — ${hint}` : message;
    const value = await prompt.input({ message: fullMessage, default: defaultValue });
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
    if (suggestion !== null && suggestion.trim().length > 0) return suggestion.trim();
    hint = 'value required';
  }
}

export function confirmSetupScriptLeaf(deps: Pick<ChainSharedDeps, 'prompt'>): Element<OnboardCtx> {
  return new Leaf<
    OnboardCtx,
    {
      readonly proposals: OnboardRepoProposals | undefined;
      readonly autoAccept: boolean;
      readonly externallyManaged: boolean;
    },
    string | null | undefined
  >('confirm-setup-script', {
    useCase: {
      async execute(input) {
        if (input.externallyManaged || input.proposals === undefined) {
          // No proposal to confirm — short-circuit. `undefined` flows through
          // applyAcceptance() in save-repo-scripts as "leave existing unchanged".
          return Result.ok(undefined);
        }
        if (input.autoAccept) {
          return Result.ok(input.proposals.setupScript);
        }
        const accepted = await promptRequiredScript(
          deps.prompt,
          'Setup script (Enter to accept, edit to change)',
          input.proposals.setupScript
        );
        return Result.ok(accepted);
      },
    },
    input: (ctx) => ({
      proposals: ctx.proposals,
      autoAccept: ctx.autoAccept,
      externallyManaged: ctx.externallyManaged === true,
    }),
    output: (ctx, value) => ({ ...ctx, acceptedSetupScript: value }),
  });
}

// ── confirm-verify-script ────────────────────────────────────────────

export function confirmVerifyScriptLeaf(deps: Pick<ChainSharedDeps, 'prompt'>): Element<OnboardCtx> {
  return new Leaf<
    OnboardCtx,
    {
      readonly proposals: OnboardRepoProposals | undefined;
      readonly autoAccept: boolean;
      readonly externallyManaged: boolean;
    },
    string | null | undefined
  >('confirm-verify-script', {
    useCase: {
      async execute(input) {
        if (input.externallyManaged || input.proposals === undefined) {
          return Result.ok(undefined);
        }
        if (input.autoAccept) {
          return Result.ok(input.proposals.verifyScript);
        }
        const accepted = await promptRequiredScript(
          deps.prompt,
          'Verify script (Enter to accept, edit to change)',
          input.proposals.verifyScript
        );
        return Result.ok(accepted);
      },
    },
    input: (ctx) => ({
      proposals: ctx.proposals,
      autoAccept: ctx.autoAccept,
      externallyManaged: ctx.externallyManaged === true,
    }),
    output: (ctx, value) => ({ ...ctx, acceptedVerifyScript: value }),
  });
}

// ── confirm-context-file ─────────────────────────────────────────────

export function confirmContextFileLeaf(deps: Pick<ChainSharedDeps, 'prompt'>): Element<OnboardCtx> {
  return new Leaf<
    OnboardCtx,
    {
      readonly proposals: OnboardRepoProposals | undefined;
      readonly autoAccept: boolean;
      readonly externallyManaged: boolean;
    },
    string | null | undefined
  >('confirm-context-file', {
    useCase: {
      async execute(input) {
        if (input.externallyManaged || input.proposals === undefined) {
          return Result.ok(null);
        }
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
    input: (ctx) => ({
      proposals: ctx.proposals,
      autoAccept: ctx.autoAccept,
      externallyManaged: ctx.externallyManaged === true,
    }),
    output: (ctx, value) => ({ ...ctx, acceptedContextFile: value ?? null }),
  });
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
      readonly proposals: OnboardRepoProposals | undefined;
      readonly accepted: string | null | undefined;
    },
    void
  >('write-context-file', {
    useCase: {
      async execute(input) {
        const { repo, proposals, accepted } = input;
        if (proposals === undefined || accepted === null || accepted === undefined || accepted.length === 0) {
          // Externally managed (no proposals) or user skipped the file —
          // leaf still completes so the trace records it.
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
