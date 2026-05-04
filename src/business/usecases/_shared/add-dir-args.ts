/**
 * `buildAdditionalCwdArgs` — translate a list of additional repo paths
 * into Claude-CLI's `--add-dir <path>` flag pairs. Returns `[]` when the
 * input is empty or undefined so callers can spread without injecting an
 * empty `args` field.
 *
 * Provider-specific knob — Copilot's CLI uses inherited cwd only and
 * doesn't accept additional roots, so passing extraArgs to Copilot is
 * a no-op (the Copilot adapter filters unknown flags). The workspace
 * builders for plan / evaluate already encode this asymmetry by mirroring
 * the affected tree(s) into the sandbox for Copilot and leaving `addDirs`
 * empty in that case — so this helper is naturally a no-op on Copilot
 * paths because the caller passes `[]`.
 *
 * Pure function, no IO — safe to call from any layer.
 */
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

export function buildAdditionalCwdArgs(paths: readonly AbsolutePath[] | undefined): readonly string[] {
  if (paths === undefined || paths.length === 0) return [];
  const args: string[] = [];
  for (const p of paths) args.push('--add-dir', String(p));
  return args;
}
