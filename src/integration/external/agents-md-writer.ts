/**
 * Filesystem surface for `project onboard` — write the provider-native
 * instructions file atomically.
 *
 * ralphctl's `aiProvider` is a global setting and only one provider is active
 * at a time, so we write the file each provider already reads:
 *
 * - `claude`  → `CLAUDE.md` at the repo root
 * - `copilot` → `.github/copilot-instructions.md` (directory created if absent)
 *
 * All writes are atomic (temp + rename) so a crash never leaves a
 * half-written file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AiProvider } from '@src/domain/models.ts';
import type { ExistingInstructions } from '@src/business/ports/onboard-adapter.ts';

const RALPHCTL_MARKER = '<!-- managed by ralphctl onboard -->';

/**
 * Resolve the provider-native instructions path for a given repo. The path is
 * a pure function of provider identity — no I/O.
 */
export function providerInstructionsPath(repoPath: string, provider: AiProvider): string {
  if (provider === 'claude') return join(repoPath, 'CLAUDE.md');
  return join(repoPath, '.github', 'copilot-instructions.md');
}

/**
 * Relative (display-friendly) form of the provider-native path — used by the
 * prompt so the AI knows what to name the file.
 */
export function providerInstructionsFileName(provider: AiProvider): string {
  if (provider === 'claude') return 'CLAUDE.md';
  return '.github/copilot-instructions.md';
}

export function readExistingProviderInstructions(repoPath: string, provider: AiProvider): ExistingInstructions {
  const path = providerInstructionsPath(repoPath, provider);
  if (!existsSync(path)) return { content: null, authored: false };
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return { content: null, authored: false };
  }
  const managed = content.includes(RALPHCTL_MARKER);
  return { content, authored: !managed };
}

export function writeProviderInstructionsAtomic(
  repoPath: string,
  content: string,
  provider: AiProvider
): { path: string } {
  const target = providerInstructionsPath(repoPath, provider);
  mkdirSync(dirname(target), { recursive: true });
  const body = content.endsWith('\n') ? content : `${content}\n`;
  const stamped = body.includes(RALPHCTL_MARKER) ? body : `${body}\n${RALPHCTL_MARKER}\n`;
  const tempPath = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tempPath, stamped, { encoding: 'utf-8', mode: 0o644 });
  renameSync(tempPath, target);
  return { path: target };
}
