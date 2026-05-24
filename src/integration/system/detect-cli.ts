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
