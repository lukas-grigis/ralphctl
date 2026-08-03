import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { ProviderInstallGuidance } from '@src/integration/system/_engine/detect-cli.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';

/**
 * Every static per-provider fact ralphctl needs, in one row. PATH binary, install guidance,
 * readiness target file, skills parent directory, and the model catalog all vary by
 * {@link AiProvider} but never change at runtime — bundling them here means a fourth backend's
 * static data lands in ONE object literal instead of four scattered `Record<AiProvider, …>`
 * maps spread across `integration/system`, `integration/ai/readiness`, `integration/ai/skills`,
 * and `application/bootstrap`. `Record<AiProvider, ProviderTraits>` gives TypeScript
 * exhaustiveness over the `AiProvider` union, so adding a member to that union without filling
 * in a row here is a compile error, not a silent runtime gap.
 *
 * Lives under `providers/_engine/` — the sanctioned cross-sibling / cross-concept surface —
 * because every consumer sits in a different concept (`integration/system`,
 * `integration/ai/readiness`, `integration/ai/skills`, `application/bootstrap`) and none of
 * them are siblings of each other.
 */
export interface ProviderTraits {
  /**
   * PATH binary the adapter spawns. MUST match `providers/<tool>/{headless,interactive}.ts` —
   * probing the wrong binary here would let the launch fail-fast pass and then the real spawn
   * fail.
   */
  readonly binary: string;
  /** Per-vendor install guidance (docs URL + OS-specific install commands). */
  readonly installGuidance: ProviderInstallGuidance;
  /**
   * Readiness artefact target path, relative to the repo root — `CLAUDE.md` / `AGENTS.md` /
   * `.github/copilot-instructions.md`.
   */
  readonly contextFileTargetPath: string;
  /** Skills parent directory, relative to the session root — `.claude` / `.agents` / `.github`. */
  readonly skillsParentDir: string;
  /**
   * Agent-definition parent directory, relative to the session root — `.claude` / `.codex` /
   * `.github`. Differs from {@link skillsParentDir} for `openai-codex` (`.codex` vs `.agents`):
   * Codex reads native agent definitions from `.codex/agents/` but Agent Skills from
   * `.agents/skills/`.
   */
  readonly agentsParentDir: string;
  /**
   * XML tag the AI should wrap its proposed readiness context-file body in — matches what the
   * harness writes to disk for this provider (`claude-md` / `copilot-instructions` /
   * `agents-md`).
   */
  readonly wireTag: string;
  /**
   * Prompt partial name holding this provider's target-file style conventions, loaded by the
   * readiness prompt builder and rendered into `<target_file_conventions>`.
   */
  readonly conventionsPartial: string;
  /** Full official model catalog the availability probe filters down. */
  readonly modelCatalog: readonly string[];
}

const NPM_INSTALL_CLAUDE = 'npm install -g @anthropic-ai/claude-code';
const NPM_INSTALL_COPILOT = 'npm install -g @github/copilot';
const NPM_INSTALL_CODEX = 'npm install -g @openai/codex';

/**
 * Install-guidance sources (verified against vendor docs at the time of writing):
 *   - claude-code:    https://docs.claude.com/en/docs/claude-code/setup
 *   - github-copilot: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-in-the-cli
 *                     plus https://cli.github.com (for the underlying `gh` install)
 *   - openai-codex:   https://github.com/openai/codex
 */
export const PROVIDER_TRAITS: Readonly<Record<AiProvider, ProviderTraits>> = {
  'claude-code': {
    binary: 'claude',
    installGuidance: {
      docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
      commandsByPlatform: {
        darwin: [
          'brew install --cask claude-code',
          'curl -fsSL https://claude.ai/install.sh | bash',
          NPM_INSTALL_CLAUDE,
        ],
        linux: ['curl -fsSL https://claude.ai/install.sh | bash', NPM_INSTALL_CLAUDE],
        win32: ['winget install Anthropic.ClaudeCode', 'irm https://claude.ai/install.ps1 | iex', NPM_INSTALL_CLAUDE],
      },
    },
    contextFileTargetPath: 'CLAUDE.md',
    skillsParentDir: '.claude',
    agentsParentDir: '.claude',
    wireTag: 'claude-md',
    conventionsPartial: 'conventions-claude-md',
    modelCatalog: CLAUDE_MODELS,
  },
  'github-copilot': {
    binary: 'copilot',
    installGuidance: {
      docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
      commandsByPlatform: {
        darwin: ['brew install copilot-cli', NPM_INSTALL_COPILOT],
        linux: [NPM_INSTALL_COPILOT, 'brew install copilot-cli'],
        win32: ['winget install GitHub.Copilot', NPM_INSTALL_COPILOT],
      },
    },
    contextFileTargetPath: '.github/copilot-instructions.md',
    skillsParentDir: '.github',
    agentsParentDir: '.github',
    wireTag: 'copilot-instructions',
    conventionsPartial: 'conventions-copilot-instructions',
    modelCatalog: COPILOT_MODELS,
  },
  'openai-codex': {
    binary: 'codex',
    installGuidance: {
      docsUrl: 'https://github.com/openai/codex',
      commandsByPlatform: {
        darwin: [
          'brew install --cask codex',
          'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
          NPM_INSTALL_CODEX,
        ],
        linux: ['curl -fsSL https://chatgpt.com/codex/install.sh | sh', NPM_INSTALL_CODEX],
        win32: [
          'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
          NPM_INSTALL_CODEX,
        ],
      },
    },
    contextFileTargetPath: 'AGENTS.md',
    skillsParentDir: '.agents',
    agentsParentDir: '.codex',
    wireTag: 'agents-md',
    conventionsPartial: 'conventions-agents-md',
    modelCatalog: CODEX_MODELS,
  },
};
