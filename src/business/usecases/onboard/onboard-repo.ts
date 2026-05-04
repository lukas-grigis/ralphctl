/**
 * `OnboardRepoUseCase` — drives one read-only AI inventory pass over a
 * repository and surfaces four review-ready proposals: the project
 * context file body (`CLAUDE.md` or `.github/copilot-instructions.md`
 * depending on the active provider), a setup script, a verify script,
 * and an optional list of skill suggestions.
 *
 * Single-responsibility on purpose: repo selection, interview-mode
 * confirmation prompts, and persistence are chain-layer concerns. This
 * use case only owns the AI round-trip + structured-signal extraction.
 *
 * Output: an `OnboardRepoProposals` bag the caller threads through the
 * review chain. The use case never writes to disk, never spawns the AI
 * with write permission, and never edits the project / repository
 * aggregates.
 */
import type { Project } from '@src/domain/entities/project.ts';
import type { Repository } from '@src/domain/entities/repository.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { Result } from '@src/domain/result.ts';
import type {
  AgentsMdProposalSignal,
  HarnessSignal,
  SetupScriptSignal,
  SkillSuggestionsSignal,
  VerifyScriptSignal,
} from '@src/domain/signals/harness-signal.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { AiProvider, AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { OnboardMode, PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser-port.ts';

/** Inputs to {@link OnboardRepoUseCase}. */
export interface OnboardRepoInput {
  readonly project: Project;
  readonly repo: Repository;
  /** Working directory for the AI session — typically the repo path. */
  readonly cwd: AbsolutePath;
  readonly mode: OnboardMode;
  readonly aiProvider: AiProvider;
  /** Heuristic project-type hint (`'node'`/`'python'`/`'go'`/`'unknown'`/…). */
  readonly projectType?: string;
  /**
   * Static check-script suggestion from the heuristic detector — surfaced
   * to the AI as a starting point when present.
   */
  readonly checkScriptSuggestion?: string;
  /**
   * Existing project context file body, when one is present. Used in
   * `adopt` / `update` modes; ignored in `bootstrap`.
   */
  readonly existingAgentsMd?: string;
  readonly abortSignal?: AbortSignal;
}

/**
 * Bundle of review-ready proposals. Every field is independently
 * approvable — a chain caller can accept the verify script while
 * rejecting the setup script, etc.
 */
export interface OnboardRepoProposals {
  /** One-line setup command, or `null` when the AI declined to propose one. */
  readonly setupScript: string | null;
  /** One-line verify command chain, or `null` when none was proposed. */
  readonly verifyScript: string | null;
  /** Full proposed body for the provider-native context file, or `null`. */
  readonly contextFileContent: string | null;
  /**
   * Provider-native target path (relative to repo root): `'CLAUDE.md'`
   * for Claude, `'.github/copilot-instructions.md'` for Copilot.
   */
  readonly contextFilePath: string;
  /** Zero or more proposed skill names; empty array when the AI declined. */
  readonly skillSuggestions: readonly string[];
  /** Raw AI stdout — kept for diagnostics and downstream re-parsing. */
  readonly rawAiOutput: string;
}

/**
 * Resolve the provider-native target file path. Centralised so chain +
 * doctor + CLI all agree on the convention.
 */
export function contextFilePathFor(provider: AiProvider): string {
  switch (provider) {
    case 'claude':
      return 'CLAUDE.md';
    case 'copilot':
      return '.github/copilot-instructions.md';
  }
}

export class OnboardRepoUseCase {
  constructor(
    private readonly ai: AiSessionPort,
    private readonly prompts: PromptBuilderPort,
    private readonly parser: SignalParserPort,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: OnboardRepoInput): Promise<Result<OnboardRepoProposals, DomainError>> {
    const log = this.logger.child({
      project: String(input.project.name),
      repo: input.repo.path,
      mode: input.mode,
      provider: input.aiProvider,
    });

    const fileName = contextFilePathFor(input.aiProvider);

    const promptResult = await this.prompts.buildOnboardPrompt({
      repoPath: input.repo.path,
      fileName,
      mode: input.mode,
      projectType: input.projectType ?? 'unknown',
      ...(input.checkScriptSuggestion !== undefined ? { checkScriptSuggestion: input.checkScriptSuggestion } : {}),
      ...(input.existingAgentsMd !== undefined ? { existingAgentsMd: input.existingAgentsMd } : {}),
    });
    if (!promptResult.ok) return Result.error(promptResult.error);

    log.info('inventorying repository for onboarding', { fileName });

    const sessionResult = await this.ai.spawnHeadless(promptResult.value, {
      cwd: input.cwd,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });
    if (!sessionResult.ok) return Result.error(sessionResult.error);

    const rawOutput = sessionResult.value.output;
    const signals = this.parser.parse(rawOutput);

    const rawProposals = extractProposals(signals, fileName, rawOutput);

    // Adopt-mode safety net. The prompt instructs the AI to emit the
    // existing prose verbatim with additions appended, but a misbehaving
    // model can still drop or reformat it. When that happens, prepend
    // the user's original body to whatever the AI emitted so the editor
    // shows a merged body the user can prune — never a silently
    // overwritten file. The check is whitespace-tolerant so a benign
    // reflow (line-break differences) doesn't trigger the merge.
    const proposals =
      input.mode === 'adopt' && input.existingAgentsMd !== undefined && rawProposals.contextFileContent !== null
        ? mergeAdoptProposalIfProseLost(rawProposals, input.existingAgentsMd, log)
        : rawProposals;

    log.info('onboarding proposals extracted', {
      hasContextFile: proposals.contextFileContent !== null,
      hasSetupScript: proposals.setupScript !== null,
      hasVerifyScript: proposals.verifyScript !== null,
      skillCount: proposals.skillSuggestions.length,
    });

    return Result.ok(proposals);
  }
}

/**
 * Whitespace-tolerant containment check. We consider the original prose
 * "preserved" when it appears in the proposal as a contiguous span
 * after normalising consecutive whitespace to single spaces. Tolerant
 * of benign reformatting; strict enough to catch summarisation,
 * paraphrasing, or omission.
 */
function preservesOriginalProse(original: string, proposal: string): boolean {
  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const o = normalize(original);
  if (o.length === 0) return true;
  return normalize(proposal).includes(o);
}

/**
 * When the AI's adopt-mode body silently drops the user's prose, fold
 * the original back in at the top with a marker comment that surfaces
 * the merge to the user during `confirm-context-file` review. The user
 * keeps full editorial control — they see both bodies side-by-side in
 * the editor and can prune duplicate sections themselves.
 */
function mergeAdoptProposalIfProseLost(
  proposals: OnboardRepoProposals,
  existing: string,
  log: LoggerPort
): OnboardRepoProposals {
  const proposal = proposals.contextFileContent;
  if (proposal === null) return proposals;
  if (preservesOriginalProse(existing, proposal)) return proposals;
  log.warn(
    'adopt-mode proposal did not preserve existing prose verbatim — prepending the original body so the user can review the merge',
    { proposalLength: proposal.length, existingLength: existing.length }
  );
  const merged = [
    existing.trimEnd(),
    '',
    '<!-- ralphctl: AI proposed additions follow. The original body above was preserved by the harness because the proposal did not include it verbatim. Review and prune duplicates. -->',
    '',
    proposal.trimStart(),
  ].join('\n');
  return { ...proposals, contextFileContent: merged };
}

/**
 * Walk the parsed signals once, picking out the four onboarding artefacts.
 * First-occurrence wins — a malformed second `<setup-script>` block is
 * ignored. Setup/verify scripts emitted as the dangerous-pattern denylist
 * are already dropped by the parser, so seeing a non-null value here is
 * safe to surface to the user as an editable default.
 */
function extractProposals(
  signals: readonly HarnessSignal[],
  contextFilePath: string,
  rawAiOutput: string
): OnboardRepoProposals {
  let agentsMd: AgentsMdProposalSignal | undefined;
  let setup: SetupScriptSignal | undefined;
  let verify: VerifyScriptSignal | undefined;
  let skills: SkillSuggestionsSignal | undefined;

  for (const signal of signals) {
    switch (signal.type) {
      case 'agents-md-proposal':
        agentsMd ??= signal;
        break;
      case 'setup-script':
        setup ??= signal;
        break;
      case 'verify-script':
        verify ??= signal;
        break;
      case 'skill-suggestions':
        skills ??= signal;
        break;
      default:
        // Ignore other variants — they're not part of the onboarding contract.
        break;
    }
  }

  return {
    setupScript: setup?.command ?? null,
    verifyScript: verify?.command ?? null,
    contextFileContent: agentsMd?.content ?? null,
    contextFilePath,
    skillSuggestions: skills?.names ?? [],
    rawAiOutput,
  };
}
