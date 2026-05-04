/**
 * Onboard chain — terminal write-side leaves.
 *
 * Steps covered: write-context-file → save-repo-scripts
 *
 * These leaves run after all user confirmations. They write the
 * accepted artefacts to disk and persist the repository metadata
 * (setup script, check script, onboardedAt timestamp) via the project
 * repository. No prompts, no AI sessions — pure persistence.
 *
 * `HARNESS_MARKER_PREFIX` is exported so the load and AI leaves can
 * detect files that were previously written by this path.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Result } from '@src/domain/result.ts';

import type { Project } from '@src/domain/entities/project.ts';
import type { Repository } from '@src/domain/entities/repository.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import type { ValidationError } from '@src/domain/values/validation-error.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { OnboardRepoProposals } from '@src/business/usecases/onboard/onboard-repo.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import type { OnboardCtx } from './onboard-flow.ts';

/**
 * Sentinel marker the harness injects on the first line of a written
 * project context file. A future onboarding pass that finds this marker
 * picks `update` mode (full replacement allowed); without it the file
 * is treated as user-authored and `adopt` mode preserves the body.
 *
 * Exported so load and AI leaves can probe for its presence without
 * duplicating the string literal.
 */
export const HARNESS_MARKER_PREFIX = '<!-- ralphctl onboard:';

function makeMarker(now: () => Date = () => new Date()): string {
  return `${HARNESS_MARKER_PREFIX} ${now().toISOString()} -->`;
}

// ── write-context-file ────────────────────────────────────────────────

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

// ── save-repo-scripts ─────────────────────────────────────────────────

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
