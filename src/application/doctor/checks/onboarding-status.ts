/**
 * `onboardingStatusCheck` — surfaces project-context state per repo so the
 * user has a clear "next step" prompt without false positives for
 * hand-authored setups.
 *
 * Per-repo detection (richer than a single boolean — see the user's case
 * where `ralphctl/ralphctl` itself ships a hand-authored `CLAUDE.md`):
 *
 *  - `ralphctl-managed` — the provider-native context file starts with
 *    the harness marker (`<!-- ralphctl onboard:`) and has no substantive
 *    preamble before it. This is what the onboard chain writes verbatim.
 *    Also matched when `Repository.onboardedAt` is set and no preamble is
 *    detected (file may be missing entirely — persisted timestamp wins).
 *  - `hybrid` — the marker is present but a substantial human-authored
 *    preamble sits above it (> `MIN_HYBRID_PROSE_CHARS` non-blank chars).
 *    The user merged manual content into a harness-managed file; doctor
 *    flags the state so the next onboard run isn't surprising. Counts as
 *    configured (no warn).
 *  - `self-managed` — the provider-native context file exists but has no
 *    harness marker. Common for repos with hand-authored CLAUDE.md /
 *    copilot-instructions.md (skills, docs, etc.). Counts as configured.
 *  - `none` — no provider-native context file. Real "needs onboarding"
 *    state.
 *
 * Aggregate status:
 *  - Zero projects → `skip`.
 *  - Every repo is ralphctl-managed / self-managed / hybrid → `pass` with
 *    a breakdown so the user sees the numbers.
 *  - At least one repo is `none` → `warn` listing only the missing repos.
 *
 * The detection logic is local to the doctor: `Repository.onboardedAt`
 * semantics are unchanged, and `project list` / `project show` continue
 * to render the persisted timestamp.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ConfigStorePort } from '@src/application/config/config-store-port.ts';
import type { AiProvider } from '@src/application/config/config.ts';
import type { DoctorCheckResult } from '@src/application/doctor/run-doctor.ts';
import type { Repository } from '@src/domain/entities/repository.ts';
import type { ProjectRepository } from '@src/domain/repositories/project-repository.ts';

export interface OnboardingStatusCheckDeps {
  readonly projectRepo: ProjectRepository;
  readonly configStore: ConfigStorePort;
}

/**
 * Per-repo onboarding state surfaced in the doctor row. Local to this
 * check — promoting it to a domain type is unwarranted until a second
 * consumer needs it.
 */
type OnboardingState = 'ralphctl-managed' | 'self-managed' | 'hybrid' | 'none';

/** First-line marker the onboard chain writes (see `chains/onboard/leaves.ts`). */
const HARNESS_MARKER_PREFIX = '<!-- ralphctl onboard:';

/**
 * Threshold (non-blank chars before the marker) above which a marker-
 * bearing file counts as `hybrid` rather than `ralphctl-managed`. ~200
 * chars is roughly one paragraph — enough to indicate genuine human
 * content, while ignoring incidental whitespace, BOMs, or short
 * boilerplate (front-matter, a one-line title) that some editors inject
 * above the marker without it being a meaningful merge.
 */
const MIN_HYBRID_PROSE_CHARS = 200;

/**
 * Provider-native context file paths, relative to the repo root. Order
 * matters when no provider is configured: prefer CLAUDE.md, then the
 * Copilot path. Both files satisfy "the repo has a project context".
 */
const CONTEXT_FILE_BY_PROVIDER: Readonly<Record<AiProvider, readonly string[]>> = {
  claude: ['CLAUDE.md'],
  copilot: ['.github/copilot-instructions.md'],
};
const CONTEXT_FILES_FALLBACK: readonly string[] = ['CLAUDE.md', '.github/copilot-instructions.md'];

function contextFilesFor(provider: AiProvider | null): readonly string[] {
  if (provider === null) return CONTEXT_FILES_FALLBACK;
  return CONTEXT_FILE_BY_PROVIDER[provider];
}

/**
 * Count non-whitespace characters in a string. Used to gauge whether a
 * preamble above the harness marker is substantive prose vs incidental
 * blank lines.
 */
function nonBlankChars(s: string): number {
  return s.replace(/\s+/g, '').length;
}

/**
 * Locate the harness marker in the file body and return the preamble
 * (everything before the marker line). Returns `null` when no marker is
 * found anywhere in the file. The marker has no closing tag — the
 * onboard chain writes it on the first line and treats every byte after
 * it as harness-managed, so we only inspect what sits *above* it.
 */
function extractPreamble(body: string): string | null {
  const idx = body.indexOf(HARNESS_MARKER_PREFIX);
  if (idx < 0) return null;
  return body.slice(0, idx);
}

/**
 * Probe a single context file and classify it. Returns `null` when the
 * file is missing (so the caller can move on to the next candidate).
 */
async function classifyContextFile(
  repoPath: string,
  relPath: string
): Promise<'ralphctl-managed' | 'self-managed' | 'hybrid' | null> {
  const fullPath = join(repoPath, relPath);
  let body: string;
  try {
    // Reading the whole file is fine — these are markdown context files,
    // typically small. Avoiding a streaming read keeps the check obvious.
    body = await readFile(fullPath, 'utf-8');
  } catch {
    return null;
  }
  const preamble = extractPreamble(body);
  if (preamble === null) return 'self-managed';
  // Marker present. If the preamble carries meaningful human prose, the
  // user has merged content alongside the harness section — flag as
  // hybrid so the next onboard run isn't a surprise.
  if (nonBlankChars(preamble) > MIN_HYBRID_PROSE_CHARS) return 'hybrid';
  return 'ralphctl-managed';
}

async function detectState(repo: Repository, provider: AiProvider | null): Promise<OnboardingState> {
  // Inspect the on-disk context file first so we can surface `hybrid`
  // even when `onboardedAt` is set — a stamped repo whose file has
  // grown a manual preamble is precisely what hybrid is for.
  for (const relPath of contextFilesFor(provider)) {
    const classified = await classifyContextFile(repo.path, relPath);
    if (classified !== null) return classified;
  }
  // No context file on disk. The persisted timestamp is still
  // authoritative "ralphctl wrote this" — file may have been moved or
  // renamed but ralphctl recorded the onboarding.
  if (repo.onboardedAt !== null) return 'ralphctl-managed';
  return 'none';
}

export async function onboardingStatusCheck(deps: OnboardingStatusCheckDeps): Promise<DoctorCheckResult> {
  const listed = await deps.projectRepo.list();
  if (!listed.ok) {
    return {
      name: 'Onboarding status',
      status: 'fail',
      message: `failed to list projects: ${listed.error.message}`,
    };
  }
  const projects = listed.value;
  if (projects.length === 0) {
    return {
      name: 'Onboarding status',
      status: 'skip',
      message: 'no projects registered',
    };
  }

  const cfg = await deps.configStore.load();
  // Config load failures fall back to "no provider configured" rather
  // than failing the whole check — onboarding state can still be inferred
  // from either context file.
  const provider: AiProvider | null = cfg.ok ? cfg.value.aiProvider : null;

  const missing: string[] = [];
  let total = 0;
  let ralphManaged = 0;
  let selfManaged = 0;
  let hybrid = 0;
  for (const project of projects) {
    for (const repo of project.repositories) {
      total++;
      const state = await detectState(repo, provider);
      if (state === 'ralphctl-managed') {
        ralphManaged++;
        continue;
      }
      if (state === 'self-managed') {
        selfManaged++;
        continue;
      }
      if (state === 'hybrid') {
        hybrid++;
        continue;
      }
      missing.push(`${String(project.name)}/${repo.name}`);
    }
  }

  if (missing.length === 0) {
    // Every state here counts as "configured" — surface the breakdown so
    // users see the mix (hand-authored CLAUDE.md, ralphctl-managed, or a
    // hybrid merge) rather than wondering if ralphctl noticed.
    const repoLabel = total === 1 ? 'repo' : 'repos';
    const message =
      selfManaged === 0 && hybrid === 0
        ? `${String(ralphManaged)}/${String(total)} ${repoLabel} onboarded`
        : `${String(total)} ${repoLabel} configured (${String(ralphManaged)} ralphctl-managed, ${String(selfManaged)} self-managed, ${String(hybrid)} hybrid)`;
    return {
      name: 'Onboarding status',
      status: 'pass',
      message,
    };
  }

  // Many-repo case: keep `message` short and scannable; surface the
  // per-repo list via `details` so the doctor view can render it as
  // indented bullets instead of a 200-char one-liner.
  const summary = `${String(missing.length)}/${String(total)} repo${missing.length === 1 ? '' : 's'} not onboarded`;
  return {
    name: 'Onboarding status',
    status: 'warn',
    message: summary,
    details: missing,
  };
}
