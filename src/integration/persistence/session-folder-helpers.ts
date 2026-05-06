/**
 * Shared low-level helpers for the session-folder builder modules.
 *
 * These utilities are internal to `src/integration/persistence/` — every
 * phase-specific builder imports from here rather than duplicating the code.
 * Nothing outside `integration/persistence/` should import this file directly.
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { AiProvider } from '@src/business/ports/ai-session-port.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { copyTree } from '@src/integration/ai/skills/copy-tree.ts';

export type Phase = 'refine' | 'ideate' | 'plan' | 'evaluate';

// ──────────────────────────── context file ───────────────────────────────

/**
 * Filename for the provider-native context file at the unit root.
 * Claude reads `CLAUDE.md` natively; Copilot reads
 * `.github/copilot-instructions.md`. No symlinks, no pointer files —
 * write whichever the active provider expects.
 */
export function contextFileFor(provider: AiProvider): { path: string; needsGithubDir: boolean } {
  if (provider === 'claude') return { path: 'CLAUDE.md', needsGithubDir: false };
  return { path: join('.github', 'copilot-instructions.md'), needsGithubDir: true };
}

/**
 * Phase-specific header for the unit's context file. Calibrated per-phase
 * so the agent knows which inputs to read and where (if at all) it may
 * touch repos outside the sandbox.
 */
export function renderContextFile(args: {
  sprint: Sprint;
  phase: Phase;
  affectedRepos: readonly AbsolutePath[];
  copilot: boolean;
}): string {
  const { sprint, phase, affectedRepos, copilot } = args;
  const header = `<!-- ralphctl unit folder: ${IsoTimestamp.now()} -->
# ${capitalise(phase)} sandbox — sprint \`${sprint.id}\`

This is a per-unit sandbox folder for the **${phase}** phase of sprint
\`${sprint.name}\`.
`;

  const inputs = renderInputsLine(phase);
  const repoLine = renderRepoLine(phase, affectedRepos, copilot);
  const guardrail = renderGuardrail(phase);

  return [header, inputs, repoLine, guardrail].filter((s) => s.length > 0).join('\n');
}

function renderInputsLine(phase: Phase): string {
  if (phase === 'refine')
    return '- Input: `./ticket.md` — the ticket to clarify. Write your refined requirements (as a JSON array per the prompt) to `./requirements.json`.\n';
  if (phase === 'ideate')
    return '- Input: `./ticket.md` — the seed idea. Write the proposed sprint output to `./output.json`.\n';
  if (phase === 'plan')
    return '- Inputs: per-ticket refined requirements live alongside this folder under `../refinement/<unit>/requirements.json`. Write your generated `tasks.json` to `./tasks.json` in this folder.\n';
  // evaluate
  return '- Inputs are in `./task.md` (the task under review), `./tasks.md` (full task plan including any sibling evaluator output), `./requirements/` (per-ticket requirements), `./project-context.md` (target repo context), and `./dimensions.md` (grading rubric).\n';
}

function renderRepoLine(phase: Phase, affectedRepos: readonly AbsolutePath[], copilot: boolean): string {
  if (phase === 'refine' || phase === 'ideate')
    return '- No repo access in this phase — refinement / ideation are implementation-agnostic.\n';
  if (phase === 'plan') {
    if (copilot) {
      if (affectedRepos.length === 0) return '- Affected repositories are mirrored under `./repos/` (read-only).\n';
      return `- Affected repositories are mirrored under \`./repos/\` (read-only): ${affectedRepos
        .map((p) => `\`${basename(p)}\``)
        .join(', ')}.\n`;
    }
    if (affectedRepos.length === 0)
      return '- Affected repositories are mounted via `--add-dir` (Claude) — read them at their absolute paths.\n';
    return `- Affected repositories are mounted via \`--add-dir\` (Claude): ${affectedRepos
      .map((p) => `\`${p}\``)
      .join(', ')}.\n`;
  }
  // evaluate
  if (copilot)
    return '- The target repository is mirrored under `./repo/` (read-only). The session spawns inside this folder.\n';
  return '- The target repository is mounted via `--add-dir`; the session spawns inside the repo so `git` commands work natively.\n';
}

function renderGuardrail(phase: Phase): string {
  if (phase === 'evaluate')
    return '- This is a read-only review. Do not edit files anywhere — emit an `<evaluation-failed>` signal with a critique instead and the harness will resume the generator.\n';
  return '- Write outputs as instructed by the prompt — do not modify files outside this folder unless the prompt explicitly directs a repo edit.\n';
}

function capitalise(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ────────────────────────── ticket input ─────────────────────────────────

/**
 * Render a ticket input file. Title / description / link headings — used
 * for both refine (`ticket.md`) and ideate (`ticket.md`) units.
 */
export function renderTicketInput(ticket: Ticket): string {
  const lines: string[] = [`# ${ticket.title}`, '', `**Ticket id:** \`${ticket.id}\``];
  if (ticket.link !== undefined) lines.push(`**Link:** ${ticket.link}`);
  lines.push('');
  if (ticket.description !== undefined && ticket.description.length > 0) {
    lines.push('## Description', '', ticket.description, '');
  }
  return lines.join('\n');
}

// ───────────────────────── file I/O utilities ────────────────────────────

export async function writeFileSafe(path: string, content: string): Promise<Result<void, StorageError>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content.endsWith('\n') ? content : `${content}\n`, { encoding: 'utf-8', mode: 0o600 });
    return Result.ok();
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`,
        path,
        cause: err,
      })
    );
  }
}

export async function ensureDirSafe(path: string): Promise<Result<void, StorageError>> {
  try {
    await mkdir(path, { recursive: true });
    return Result.ok();
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to create directory ${path}: ${err instanceof Error ? err.message : String(err)}`,
        path,
        cause: err,
      })
    );
  }
}

/**
 * Copy a single file, creating the destination's parent directory if
 * needed. The result is a real, independent copy — no symlinks — so
 * the destination folder remains reproducible if the source ever moves
 * or is deleted.
 */
export async function copyFileSafe(src: string, dst: string): Promise<Result<void, StorageError>> {
  try {
    await mkdir(dirname(dst), { recursive: true });
    await cp(src, dst, { force: true });
    return Result.ok();
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to copy ${src} → ${dst}: ${err instanceof Error ? err.message : String(err)}`,
        path: dst,
        cause: err,
      })
    );
  }
}

/**
 * Mirror a real repo into a sandbox subdirectory. Tries `fs.cp` first
 * and falls back to the recursive `copyTree` helper on `EXDEV`.
 */
export async function mirrorRepo(src: AbsolutePath, dst: string): Promise<Result<void, StorageError>> {
  try {
    await rm(dst, { recursive: true, force: true });
    await mkdir(dirname(dst), { recursive: true });
    await cp(src, dst, { recursive: true, dereference: false, errorOnExist: false, force: true });
    return Result.ok();
  } catch (err) {
    const errno = (err as { code?: string }).code;
    if (errno === 'EXDEV') {
      return copyTree(src, dst);
    }
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to mirror ${src} → ${dst}: ${err instanceof Error ? err.message : String(err)}`,
        path: dst,
        cause: err,
      })
    );
  }
}

// ─────────────────────── write context file ──────────────────────────────

/**
 * Write the provider-native context file at `<root>/<provider-file>`.
 * Creates `.github/` if needed for Copilot.
 */
export async function writeContextFile(args: {
  root: AbsolutePath;
  sprint: Sprint;
  provider: AiProvider;
  phase: Phase;
  affectedRepos: readonly AbsolutePath[];
}): Promise<Result<void, StorageError>> {
  const { path, needsGithubDir } = contextFileFor(args.provider);
  if (needsGithubDir) {
    const ensure = await ensureDirSafe(join(args.root, '.github'));
    if (!ensure.ok) return Result.error(ensure.error);
  }
  const body = renderContextFile({
    sprint: args.sprint,
    phase: args.phase,
    affectedRepos: args.affectedRepos,
    copilot: args.provider === 'copilot',
  });
  return writeFileSafe(join(args.root, path), body);
}
