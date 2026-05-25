import { spawn } from 'node:child_process';
import type { AiProvider } from '@src/domain/entity/settings.ts';

/**
 * Map provider id → the binary the user must have on PATH for that provider to function.
 * `claude` and `codex` are the standalone CLIs; for `github-copilot` we probe `gh` (the GitHub
 * CLI), which is the entry point ralphctl reaches the Copilot extension through.
 *
 * Single source of truth — used by `detectInstalledProviders`, the apply-preset warning surface,
 * and the fail-fast launch helper.
 */
export const PROVIDER_BINARY: Readonly<Record<AiProvider, string>> = {
  'claude-code': 'claude',
  'github-copilot': 'gh',
  'openai-codex': 'codex',
};

/**
 * The three desktop OS families ralphctl supports. `darwin` / `linux` / `win32` mirror Node's
 * `process.platform` values; any other value the runtime might report (`aix`, `freebsd`, …)
 * is mapped onto `linux` by {@link resolveInstallPlatform}, since the POSIX install paths apply.
 */
export type InstallPlatform = 'darwin' | 'linux' | 'win32';

/**
 * Per-provider install guidance derived from each vendor's official setup docs. Each OS lists
 * commands in recommended order — the first entry is the one ralphctl points operators at
 * inline; the rest surface as "alternatives" in the richer render. `docsUrl` is the canonical
 * setup page operators can open when none of the listed commands fit their environment.
 *
 * Sources (verified against vendor docs at the time of writing):
 *   - claude-code:    https://docs.claude.com/en/docs/claude-code/setup
 *   - github-copilot: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-in-the-cli
 *                     plus https://cli.github.com (for the underlying `gh` install)
 *   - openai-codex:   https://github.com/openai/codex
 *
 * Single source of truth — adding a new provider means one entry here plus the existing entry
 * in `PROVIDER_BINARY`.
 */
export interface ProviderInstallGuidance {
  readonly docsUrl: string;
  readonly commandsByPlatform: Readonly<Record<InstallPlatform, readonly string[]>>;
}

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
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-in-the-cli',
    commandsByPlatform: {
      darwin: ['brew install gh && gh extension install github/gh-copilot', 'gh extension install github/gh-copilot'],
      linux: [
        'install gh from https://github.com/cli/cli/blob/trunk/docs/install_linux.md, then: gh extension install github/gh-copilot',
        'gh extension install github/gh-copilot',
      ],
      win32: [
        'winget install --id GitHub.cli && gh extension install github/gh-copilot',
        'gh extension install github/gh-copilot',
      ],
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
 * Test seam — async predicate that returns `true` when the binary resolves on the current
 * `PATH`. The production implementation shells out to `command -v <binary>`; tests inject a
 * stub that returns based on a mocked set.
 */
export type WhichFn = (binary: string) => Promise<boolean>;

/**
 * Default `which`-equivalent. Spawns `command -v <binary>` with `stdio: 'pipe'` (suppressing
 * output) and resolves based on the exit code. POSIX-portable: `command -v` is a shell builtin
 * mandated by the spec, available in every POSIX shell.
 *
 * Resolution policy:
 *   - exit code 0      → true (binary exists on PATH)
 *   - exit code non-0  → false (not on PATH)
 *   - spawn error      → false (treat as missing)
 *
 * No version check, no auth probe — just presence.
 */
const defaultWhich: WhichFn = (binary) =>
  new Promise((resolve) => {
    const child = spawn('command', ['-v', binary], { stdio: 'pipe', shell: true });
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.on('error', () => settle(false));
    child.on('exit', (code) => settle(code === 0));
  });

export interface DetectInstalledProvidersOptions {
  /** Test seam — defaults to the `command -v <binary>` implementation. */
  readonly which?: WhichFn;
}

/**
 * Probe PATH for every supported provider's CLI binary; return the set of providers whose
 * binary resolves. Pure (no logging, no side effects beyond the `which` calls). Probes run in
 * parallel — three lightweight `command -v` invocations land well under any user-perceptible
 * threshold.
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
