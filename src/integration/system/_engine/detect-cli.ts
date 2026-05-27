/**
 * Port-shaped contracts for the provider-binary detector. Lives in `_engine/` so consumers
 * (settings-apply-preset, settings-set-provider, welcome view) depend on a port type, not the
 * concrete `detect-cli.ts` implementation.
 *
 * The runtime probe (`detectInstalledProviders`) and the install-command renderer live in
 * `system/detect-cli.ts`; only the input/option shapes belong here.
 */

/**
 * The three desktop OS families ralphctl supports. `darwin` / `linux` / `win32` mirror Node's
 * `process.platform` values; any other value the runtime might report (`aix`, `freebsd`, …)
 * is mapped onto `linux` by `resolveInstallPlatform`, since the POSIX install paths apply.
 */
export type InstallPlatform = 'darwin' | 'linux' | 'win32';

/**
 * Per-provider install guidance derived from each vendor's official setup docs. Each OS lists
 * commands in recommended order — the first entry is the one ralphctl points operators at
 * inline; the rest surface as "alternatives" in the richer render. `docsUrl` is the canonical
 * setup page operators can open when none of the listed commands fit their environment.
 */
export interface ProviderInstallGuidance {
  readonly docsUrl: string;
  readonly commandsByPlatform: Readonly<Record<InstallPlatform, readonly string[]>>;
}

/**
 * Test seam — async predicate that returns `true` when the binary resolves on the current
 * `PATH`. The production implementation shells out to `command -v <binary>`; tests inject a
 * stub that returns based on a mocked set.
 */
export type WhichFn = (binary: string) => Promise<boolean>;

export interface DetectInstalledProvidersOptions {
  /** Test seam — defaults to the `command -v <binary>` implementation. */
  readonly which?: WhichFn;
}
