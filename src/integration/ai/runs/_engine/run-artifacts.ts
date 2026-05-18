import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Per-run forensic artifacts under `<dataRoot>/runs/<flow>/<run-id>/`.
 *
 * One-shot AI flows (detect-scripts / detect-skills / readiness) materialise their rendered
 * prompt + raw AI body here so an empty or surprising proposal is forensically diagnosable
 * after the chain exits. Sprint flows persist their own trace under `<sprintDir>/chain.log`;
 * `runsRoot` covers the one-shot path that previously left nothing on disk.
 *
 * Lifecycle is user-managed: `rm -rf <runsRoot>` at any point is safe. No auto-GC — the
 * failure mode of losing a forensic record is worse than the cost of an occasional rm.
 */

/** Max chars of body.txt shown inline in confirm prompts / error hints before truncation. */
export const BODY_PREVIEW_LIMIT = 800;

/**
 * Build a unique run directory name. Lexicographic sort = chronological sort, which is what
 * an operator wants when they `ls` the runs dir. Random suffix keeps two near-simultaneous
 * runs from colliding in the same millisecond.
 */
export const buildRunDirName = (): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
};

export interface ReadRunBodyPreviewOptions {
  /**
   * Suffix appended after the truncated head when the body exceeds {@link BODY_PREVIEW_LIMIT}.
   * Defaults to ` […truncated]` (single line, space-prefixed). Confirm leaves typically pass
   * a multi-line trailer that includes the body.txt path; error hints stick with the default.
   */
  readonly truncatedSuffix?: string;
}

/**
 * Read `<runDir>/body.txt` for an inline preview. Returns a trimmed + (optionally) truncated
 * string when the file exists and has content, `undefined` otherwise. Never throws —
 * diagnostic UX must degrade gracefully when the body file is absent (Copilot / Codex
 * providers that don't implement `bodyFile`) or unreadable.
 */
export const readRunBodyPreview = async (
  runDir: AbsolutePath,
  options?: ReadRunBodyPreviewOptions
): Promise<string | undefined> => {
  try {
    const raw = await fs.readFile(join(String(runDir), 'body.txt'), 'utf8');
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length <= BODY_PREVIEW_LIMIT) return trimmed;
    const head = trimmed.slice(0, BODY_PREVIEW_LIMIT).trimEnd();
    const suffix = options?.truncatedSuffix ?? ' […truncated]';
    return `${head}${suffix}`;
  } catch {
    return undefined;
  }
};
