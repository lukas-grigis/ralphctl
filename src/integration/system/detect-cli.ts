import { commandExists } from '@src/integration/io/command-exists.ts';
import { type RunCommand, runCommand } from '@src/integration/io/run-command.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';
import type {
  DetectInstalledProvidersOptions,
  InstallPlatform,
  ProviderInstallGuidance,
  UnsupportedProviderVersion,
  WhichFn,
} from '@src/integration/system/_engine/detect-cli.ts';

const PROVIDERS = Object.keys(PROVIDER_TRAITS) as readonly AiProvider[];

const traitMap = <T>(pick: (p: AiProvider) => T): Readonly<Record<AiProvider, T>> =>
  Object.fromEntries(PROVIDERS.map((p) => [p, pick(p)])) as Record<AiProvider, T>;

/**
 * The binary each provider's adapters spawn, read from {@link PROVIDER_TRAITS} — so the PATH
 * probe and the spawn cannot disagree (`copilot` is the AI backend; `gh` is only the SCM CLI).
 */
export const PROVIDER_BINARY = traitMap((p) => PROVIDER_TRAITS[p].binary);

export const PROVIDER_INSTALL_GUIDANCE: Readonly<Record<AiProvider, ProviderInstallGuidance>> = traitMap(
  (p) => PROVIDER_TRAITS[p].installGuidance
);

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

// First `major.minor.patch` in the reply; tolerates a `v` prefix or a leading product name.
const SEMVER_RE = /(?<![\d.])(\d+)\.\d+\.\d+/;

/**
 * Read `<binary> --version` for a provider whose traits declare a `versionGate` and report a
 * major other than the supported one. Fails open: no gate, a failed run or an unparseable reply
 * resolves `undefined`, so a CLI that changes its version output never blocks a launch.
 */
export const probeUnsupportedVersion = async (
  provider: AiProvider,
  run: RunCommand = runCommand
): Promise<UnsupportedProviderVersion | undefined> => {
  const gate = PROVIDER_TRAITS[provider].versionGate;
  if (gate === undefined) return undefined;
  const result = await run(PROVIDER_BINARY[provider], ['--version']);
  if (!result.ok) return undefined;
  const match = SEMVER_RE.exec(result.stdout);
  if (match?.[1] === undefined) return undefined;
  if (Number(match[1]) === gate.supportedMajor) return undefined;
  return { provider, version: match[0], supportedMajor: gate.supportedMajor, installHint: gate.installHint };
};

/**
 * The providers whose binary resolves on PATH, probed in parallel. The default probe is the shared
 * {@link commandExists}, so this and the doctor's PATH checks can never disagree (on Windows a bare
 * spawn cannot launch the npm / winget `.cmd` shims).
 */
export const detectInstalledProviders = async (
  options: DetectInstalledProvidersOptions = {}
): Promise<ReadonlySet<AiProvider>> => {
  const which: WhichFn = options.which ?? commandExists;
  const present = await Promise.all(PROVIDERS.map((p) => which(PROVIDER_BINARY[p])));
  return new Set(PROVIDERS.filter((_, i) => present[i]));
};
