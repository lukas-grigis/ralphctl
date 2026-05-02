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

    const proposals = extractProposals(signals, fileName, rawOutput);
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
