import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { ProviderInstallGuidance } from '@src/integration/system/_engine/detect-cli.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';
import { OPENCODE_MODELS } from '@src/domain/value/settings-models/opencode.ts';
import { GROK_MODELS } from '@src/domain/value/settings-models/grok.ts';

/**
 * Every static per-provider fact ralphctl needs, in one row. PATH binary, install guidance,
 * readiness target file, skills parent directory, and the model catalog all vary by
 * {@link AiProvider} but never change at runtime — bundling them here means a new backend's
 * static data lands in ONE object literal instead of scattered `Record<AiProvider, …>`
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
  /**
   * Whether this provider forwards `effort` to its CLI, per SURFACE. Capability is not a
   * provider-level fact: OpenCode forwards effort on the headless `run` subcommand and cannot on
   * the interactive one, so a single flag would have to lie about one of them.
   *
   * Declared here rather than inferred from the adapters so the port-conformance suites can assert
   * argv against a DECLARATION in both directions — an adapter that starts (or stops) forwarding
   * without updating its row fails the suite instead of quietly changing what an operator's
   * configured effort does. `Record<AiProvider, ProviderTraits>` then makes answering the question
   * mandatory for a fifth backend.
   *
   * @see `EFFORT_CAPABLE_PROVIDERS` in `business/task/escalation-map.ts` — the business-layer view
   * of the same question (may this provider be escalated by raising effort?), which is
   * provider-level because escalation only ever runs headless.
   */
  readonly effortForwarding: {
    readonly headless: boolean;
    readonly interactive: boolean;
  };
}

/** Forwarded on both surfaces — every backend except OpenCode's interactive command. */
const EFFORT_ON_BOTH_SURFACES = { headless: true, interactive: true } as const;

const NPM_INSTALL_CLAUDE = 'npm install -g @anthropic-ai/claude-code';
const NPM_INSTALL_COPILOT = 'npm install -g @github/copilot';
const NPM_INSTALL_CODEX = 'npm install -g @openai/codex';
const NPM_INSTALL_OPENCODE = 'npm install -g opencode-ai';
const NPM_INSTALL_GROK = 'npm install -g @xai-official/grok';
/** OpenCode keeps skills, agents and config under one project directory. */
const OPENCODE_PARENT_DIR = '.opencode';
const OPENCODE_INSTALL_SH = 'curl -fsSL https://opencode.ai/install | bash';
const GROK_PARENT_DIR = '.grok';
const GROK_INSTALL_SH = 'curl -fsSL https://x.ai/cli/install.sh | bash';
/** Shared by Codex, OpenCode, and Grok — the cross-tool AGENTS.md convention. */
const AGENTS_MD = 'AGENTS.md';
const AGENTS_MD_WIRE_TAG = 'agents-md';
const AGENTS_MD_CONVENTIONS = 'conventions-agents-md';

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
    // `--effort <level>` on both the headless and the interactive command.
    effortForwarding: EFFORT_ON_BOTH_SURFACES,
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
    // `--effort=<level>` on both surfaces (equals-only, per the CLI reference).
    effortForwarding: EFFORT_ON_BOTH_SURFACES,
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
    contextFileTargetPath: AGENTS_MD,
    skillsParentDir: '.agents',
    agentsParentDir: '.codex',
    wireTag: AGENTS_MD_WIRE_TAG,
    conventionsPartial: AGENTS_MD_CONVENTIONS,
    modelCatalog: CODEX_MODELS,
    // `-c model_reasoning_effort=<level>` on both surfaces.
    effortForwarding: EFFORT_ON_BOTH_SURFACES,
  },
  opencode: {
    binary: 'opencode',
    installGuidance: {
      docsUrl: 'https://opencode.ai/docs/',
      commandsByPlatform: {
        darwin: ['brew install sst/tap/opencode', OPENCODE_INSTALL_SH, NPM_INSTALL_OPENCODE],
        linux: [OPENCODE_INSTALL_SH, NPM_INSTALL_OPENCODE],
        win32: [NPM_INSTALL_OPENCODE, OPENCODE_INSTALL_SH],
      },
    },
    // OpenCode reads the same `AGENTS.md` convention codex does, so both share the context-file
    // target and its prompt partial rather than duplicating a near-identical one.
    contextFileTargetPath: AGENTS_MD,
    skillsParentDir: OPENCODE_PARENT_DIR,
    agentsParentDir: OPENCODE_PARENT_DIR,
    wireTag: AGENTS_MD_WIRE_TAG,
    conventionsPartial: AGENTS_MD_CONVENTIONS,
    // Only the zero-auth free tier — OpenCode aggregates upstream providers, so the picker's real
    // list comes from `createOpencodeModelAvailabilityProbe` shelling out to `opencode models`. See
    // `domain/value/settings-models/opencode.ts`.
    modelCatalog: OPENCODE_MODELS,
    // The only asymmetric row. `--variant <level>` exists on `opencode run` (headless) but not on
    // the default TUI command, which is yargs-strict and exits 1 with a usage banner on an unknown
    // flag — so forwarding an operator's configured effort interactively would turn a working
    // session into a hard spawn failure. The interactive adapter drops it deliberately.
    effortForwarding: { headless: true, interactive: false },
  },
  'xai-grok': {
    binary: 'grok',
    installGuidance: {
      docsUrl: 'https://docs.x.ai/build/overview',
      commandsByPlatform: {
        darwin: [GROK_INSTALL_SH, NPM_INSTALL_GROK],
        linux: [GROK_INSTALL_SH, NPM_INSTALL_GROK],
        win32: ['irm https://x.ai/cli/install.ps1 | iex', NPM_INSTALL_GROK],
      },
    },
    contextFileTargetPath: AGENTS_MD,
    skillsParentDir: GROK_PARENT_DIR,
    agentsParentDir: GROK_PARENT_DIR,
    wireTag: AGENTS_MD_WIRE_TAG,
    conventionsPartial: AGENTS_MD_CONVENTIONS,
    modelCatalog: GROK_MODELS,
    effortForwarding: EFFORT_ON_BOTH_SURFACES,
  },
};
