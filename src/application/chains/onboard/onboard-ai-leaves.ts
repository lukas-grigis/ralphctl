/**
 * Onboard chain — AI-session leaves.
 *
 * Steps covered: confirm-start-ai → run-onboard-ai
 *
 * `confirm-start-ai` is the HITL gate immediately before the AI
 * inventory pass. `run-onboard-ai` drives the read-only AI session and
 * collects the proposals that downstream confirm leaves review.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';

import type { Project } from '@src/domain/entities/project.ts';
import type { Repository } from '@src/domain/entities/repository.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import {
  contextFilePathFor,
  OnboardRepoUseCase,
  type OnboardRepoProposals,
} from '@src/business/usecases/onboard/onboard-repo.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import type { OnboardCtx } from './onboard-flow.ts';
import { HARNESS_MARKER_PREFIX } from './onboard-persist-leaves.ts';

// ── confirm-start-ai ──────────────────────────────────────────────────

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

// ── run-onboard-ai ────────────────────────────────────────────────────

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
