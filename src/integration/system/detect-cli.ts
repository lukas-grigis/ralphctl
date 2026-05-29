import { commandExists } from '@src/integration/io/command-exists.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type {
  DetectInstalledProvidersOptions,
  InstallPlatform,
  ProviderInstallGuidance,
  WhichFn,
} from '@src/integration/system/_engine/detect-cli.ts';

/**
 * Map provider id → the binary the user must have on PATH for that provider to function.
 * All three are standalone CLIs: `claude`, `codex`, and `copilot` (the GitHub Copilot CLI,
 * `copilot` v1.0.12+ — `npm install -g @github/copilot`). This MUST match the binary each
 * provider adapter actually spawns (`providers/<tool>/{headless,interactive}.ts`); probing
 * `gh` here while the adapter spawns `copilot` would let the launch fail-fast pass and then
 * the real spawn fail (`gh` is a separate SCM dependency for create-pr / issue sync, not the
 * Copilot AI backend).
 *
 * Single source of truth — used by `detectInstalledProviders`, the apply-preset warning surface,
 * and the fail-fast launch helper.
 */
export const PROVIDER_BINARY: Readonly<Record<AiProvider, string>> = {
  'claude-code': 'claude',
  'github-copilot': 'copilot',
  'openai-codex': 'codex',
};

/**
 * Per-vendor install guidance entries. Sources (verified against vendor docs at the time of
 * writing):
 *   - claude-code:    https://docs.claude.com/en/docs/claude-code/setup
 *   - github-copilot: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-in-the-cli
 *                     plus https://cli.github.com (for the underlying `gh` install)
 *   - openai-codex:   https://github.com/openai/codex
 *
 * Single source of truth — adding a new provider means one entry here plus the existing entry
 * in `PROVIDER_BINARY`. Port-shaped types ({@link ProviderInstallGuidance}, {@link InstallPlatform})
 * live in `_engine/detect-cli.ts`.
 */
export const PROVIDER_INSTALL_GUIDANCE: Readonly<Record<AiProvider, ProviderInstallGuidance>> = {
  'claude-code': {
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    commandsByPlatform: {
      darwin: [
        'brew install --cask claude-code',
        'curl -fsSL https://claude.ai/install.sh | bash',
        'npm install -g @anthropic-ai/claude-code',
      ],
      linux: ['curl -fsSL https://claude.ai/install.sh | bash', 'npm install -g @anthropic-ai/claude-code'],
      win32: [
        'winget install Anthropic.ClaudeCode',
        'irm https://claude.ai/install.ps1 | iex',
        'npm install -g @anthropic-ai/claude-code',
      ],
    },
  },
  'github-copilot': {
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
    commandsByPlatform: {
      darwin: ['brew install copilot-cli', 'npm install -g @github/copilot'],
      linux: ['npm install -g @github/copilot', 'brew install copilot-cli'],
      win32: ['winget install GitHub.Copilot', 'npm install -g @github/copilot'],
    },
  },
  'openai-codex': {
    docsUrl: 'https://github.com/openai/codex',
    commandsByPlatform: {
      darwin: [
        'brew install --cask codex',
        'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
        'npm install -g @openai/codex',
      ],
      linux: ['curl -fsSL https://chatgpt.com/codex/install.sh | sh', 'npm install -g @openai/codex'],
      win32: [
        'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
        'npm install -g @openai/codex',
      ],
    },
  },
};

/**
 * Collapse Node's `process.platform` onto the three OS families we publish guidance for.
 * Unknown values (e.g. `aix`, `freebsd`) fall back to `linux` — its POSIX install commands
 * are the closest match.
 */
export const resolveInstallPlatform = (platform: NodeJS.Platform = process.platform): InstallPlatform => {
  if (platform === 'darwin' || platform === 'win32') return platform;
  return 'linux';
};

/**
 * One-line install command tailored to the operator's OS — the first entry in the OS-specific
 * list (brew on macOS, winget on Windows, the curl installer on Linux). Used in inline,
 * space-constrained surfaces (TUI footer, single-line launch banner, ValidationError summary).
 */
export const primaryInstallCommand = (provider: AiProvider, platform: NodeJS.Platform = process.platform): string => {
  const os = resolveInstallPlatform(platform);
  const list = PROVIDER_INSTALL_GUIDANCE[provider].commandsByPlatform[os];
  const first = list[0];
  if (first === undefined) {
    throw new Error(`No install command registered for ${provider} on ${os}`);
  }
  return first;
};

/**
 * Render the multi-line "install X" guidance ralphctl shows when an availability gate fires.
 * Lists every OS-appropriate install option (brew, winget, native installer, npm) plus a link
 * to the vendor's setup docs so operators can verify against the canonical source. Used in
 * richer contexts (validation-error hint, doctor-style banners) where a single one-liner is
 * not enough.
 *
 * Format:
 *
 *   <provider> CLI (<binary>) not on PATH
 *   Install options (<os>):
 *     • <cmd 1>
 *     • <cmd 2>
 *   Docs: <docs url>
 */
export const renderProviderInstallGuidance = (
  provider: AiProvider,
  platform: NodeJS.Platform = process.platform
): string => {
  const os = resolveInstallPlatform(platform);
  const guidance = PROVIDER_INSTALL_GUIDANCE[provider];
  const commands = guidance.commandsByPlatform[os];
  const header = `${provider} CLI (${PROVIDER_BINARY[provider]}) not on PATH`;
  const bullets = commands.map((c) => `  • ${c}`).join('\n');
  return `${header}\nInstall options (${os}):\n${bullets}\nDocs: ${guidance.docsUrl}`;
};

/**
 * Default `which`-equivalent — delegates to the shared cross-platform {@link commandExists}
 * probe (`where` on Windows, `command -v` on POSIX). Routing provider detection and the
 * doctor's PATH checks through one mechanism guarantees they can never disagree — notably on
 * Windows, where the POSIX `command -v` builtin is absent from `cmd.exe` and a bare spawn
 * cannot launch the `.cmd` / `.ps1` shims that npm / winget install.
 *
 * Resolution policy: on PATH → true; absent or spawn error → false. No version / auth probe.
 */
const defaultWhich: WhichFn = commandExists;

/**
 * Probe PATH for every supported provider's CLI binary; return the set of providers whose
 * binary resolves. Pure (no logging, no side effects beyond the `which` calls). Probes run in
 * parallel — three lightweight PATH lookups land well under any user-perceptible threshold.
 *
 * Used at three sites:
 *   - fresh-install seeding (welcome view) — pick a preset from the single / zero / 2+ result
 *   - preset-apply warning surface — flag providers configured but not installed
 *   - launch-time fail-fast — abort before spawning a missing binary
 *
 * Editing a single per-flow row never triggers this probe; detection is only invoked at the
 * three sites named above.
 */
export const detectInstalledProviders = async (
  options: DetectInstalledProvidersOptions = {}
): Promise<ReadonlySet<AiProvider>> => {
  const which = options.which ?? defaultWhich;
  const providers = Object.keys(PROVIDER_BINARY) as readonly AiProvider[];
  const results = await Promise.all(providers.map(async (p) => [p, await which(PROVIDER_BINARY[p])] as const));
  const installed = new Set<AiProvider>();
  for (const [provider, present] of results) {
    if (present) installed.add(provider);
  }
  return installed;
};
