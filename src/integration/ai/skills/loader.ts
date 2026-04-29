import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { SkillNameCollisionError } from '@src/domain/errors.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { ResolvedSkill, SkillPhase } from '@src/business/ports/skills.ts';

/**
 * Absolute path to the directory holding this loader file. Resolved at module
 * load via `import.meta.url` because Node's NodeNext resolver does not provide
 * `__dirname` for ESM modules.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the built-in skills root in dev (`src/skills/`) or in the npm bundle
 * (`dist/skills/`). The bundle ships skills next to `cli.mjs` via the
 * package.json build copy step; in dev the loader file lives at
 * `src/integration/ai/skills/loader.ts` so `src/skills/` is three directories
 * up. `existsSync` on the bundled path is the same dev-vs-dist seam the prompt
 * loader uses.
 */
function getBuiltinSkillsRoot(): string {
  const bundled = join(HERE, '..', '..', '..', 'skills');
  // In dist, `HERE` is `dist/`, so `<HERE>/skills` is `dist/skills/`.
  const distInline = join(HERE, 'skills');
  if (existsSync(distInline)) return distInline;
  // In dev, `HERE` is `src/integration/ai/skills/`, so go up to `src/skills/`.
  return resolve(bundled);
}

/**
 * User skills root. Honors `RALPHCTL_ROOT` so tests (and multi-workspace
 * setups) can point at a tmpdir without polluting the user's real home.
 *
 * Computed lazily because `RALPHCTL_ROOT` may be set in test setup files
 * after this module is imported — capturing it at module load would lock in
 * the pre-test value.
 */
function getUserSkillsRoot(): string {
  const root = process.env['RALPHCTL_ROOT'] ?? join(homedir(), '.ralphctl');
  return join(root, 'skills');
}

interface SkillFrontmatter {
  name: string;
  description: string;
}

/**
 * Parse the YAML-ish frontmatter at the top of a SKILL.md. Only `name` and
 * `description` are recognized — additional fields are ignored, matching the
 * Claude Code skill spec where supplementary metadata is reserved for future
 * use.
 *
 * Returns `null` when the document does not start with a `---` fence, when
 * the fence is unterminated, or when either required field is missing /
 * blank. The caller surfaces these failures as warnings and skips the skill
 * entirely; no partial fields are returned.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  // Tolerate a UTF-8 BOM and any leading blank lines so a SKILL.md saved by
  // a tool that prepends either still parses. The opening fence must be the
  // first non-blank line — anything else is a malformed skill.
  let body = content;
  if (body.startsWith('﻿')) body = body.slice(1);
  body = body.replace(/^[ \t]*\r?\n/, '');
  if (!body.startsWith('---')) return null;

  const closingFenceIndex = body.indexOf('\n---', 3);
  if (closingFenceIndex === -1) return null;

  const fmText = body.slice(3, closingFenceIndex).trim();
  const fields = new Map<string, string>();
  for (const rawLine of fmText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip a single pair of surrounding quotes for `description: "…"` or
    // `description: '…'`. Multi-line YAML values are not supported — the
    // skill spec keeps these to a single line per field.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fields.set(key, value);
  }

  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !description) return null;
  return { name, description };
}

/**
 * One discovered skill directory before validation.
 */
interface CandidateSkill {
  /** Absolute path to the skill directory (parent of SKILL.md). */
  sourcePath: string;
  /** Origin tag — used for warnings + the `origin` field of `ResolvedSkill`. */
  origin: 'builtin' | 'user';
}

/**
 * Sibling directory of every phase whose skills are unioned into all phases.
 * Any loose files at this level are ignored by the directory filter — only
 * `default/<skill>/SKILL.md` subdirectories are loaded.
 */
const DEFAULT_PHASE_DIR = 'default';

async function listSkillCandidatesIn(parentDir: string, origin: 'builtin' | 'user'): Promise<CandidateSkill[]> {
  let entries: string[];
  try {
    const dirents = await readdir(parentDir, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // ENOENT for the user tree is the common "no custom skills" path — the
    // built-in tree should always exist, but treating both the same keeps
    // the loader resilient to a partially-deployed install.
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }

  return entries.map((name) => ({ sourcePath: join(parentDir, name), origin }));
}

async function listSkillCandidates(
  root: string,
  phase: SkillPhase,
  origin: 'builtin' | 'user'
): Promise<CandidateSkill[]> {
  const [phaseEntries, defaultEntries] = await Promise.all([
    listSkillCandidatesIn(join(root, phase), origin),
    listSkillCandidatesIn(join(root, DEFAULT_PHASE_DIR), origin),
  ]);
  return [...phaseEntries, ...defaultEntries];
}

/**
 * Validate a candidate skill: SKILL.md must exist, be readable, and parse
 * into a frontmatter pair. Returns either the resolved skill or a typed
 * failure carrying the reason — callers surface both as warnings.
 */
async function validateSkill(
  candidate: CandidateSkill
): Promise<{ ok: true; skill: ResolvedSkill } | { ok: false; reason: string; sourcePath: string }> {
  const skillFile = join(candidate.sourcePath, 'SKILL.md');
  let content: string;
  try {
    const stats = await stat(skillFile);
    if (!stats.isFile()) {
      return { ok: false, reason: 'SKILL.md is not a regular file', sourcePath: candidate.sourcePath };
    }
    content = await readFile(skillFile, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const reason = code === 'ENOENT' ? 'SKILL.md is missing' : `SKILL.md is unreadable (${code ?? 'unknown'})`;
    return { ok: false, reason, sourcePath: candidate.sourcePath };
  }

  const parsed = parseSkillFrontmatter(content);
  if (!parsed) {
    return {
      ok: false,
      reason: 'SKILL.md frontmatter missing or invalid (require `name` and `description`)',
      sourcePath: candidate.sourcePath,
    };
  }

  return {
    ok: true,
    skill: {
      name: parsed.name,
      description: parsed.description,
      sourcePath: candidate.sourcePath,
      origin: candidate.origin,
    },
  };
}

export interface LoadSkillsOptions {
  /** Override the built-in skills root — exposed for tests. */
  builtinRoot?: string;
  /** Override the user skills root — exposed for tests. */
  userRoot?: string;
  /** Logger for invalid-skill warnings. Optional — silent when absent. */
  logger?: LoggerPort;
}

/**
 * Resolve the skill set for `phase` from the built-in tree and the user
 * tree (`~/.ralphctl/skills/<phase>/`).
 *
 * Failure modes:
 *   - Invalid SKILL.md (missing, unreadable, malformed frontmatter) — the
 *     skill is excluded from the returned set and a warning is logged
 *     identifying its path and reason.
 *   - Name collision between any two valid skills (built-in vs user, two
 *     user skills, two built-in skills) — throws `SkillNameCollisionError`
 *     listing both source paths so the user can resolve the conflict.
 *
 * Empty or missing user tree is normal and never an error.
 */
export async function loadSkillsForPhase(phase: SkillPhase, options: LoadSkillsOptions = {}): Promise<ResolvedSkill[]> {
  const builtinRoot = options.builtinRoot ?? getBuiltinSkillsRoot();
  const userRoot = options.userRoot ?? getUserSkillsRoot();
  const logger = options.logger;

  const [builtinCandidates, userCandidates] = await Promise.all([
    listSkillCandidates(builtinRoot, phase, 'builtin'),
    listSkillCandidates(userRoot, phase, 'user'),
  ]);
  const candidates = [...builtinCandidates, ...userCandidates];

  const validated = await Promise.all(candidates.map(validateSkill));

  const resolved: ResolvedSkill[] = [];
  const byName = new Map<string, ResolvedSkill>();
  for (const result of validated) {
    if (!result.ok) {
      logger?.warning(`Skipping invalid skill at ${result.sourcePath}: ${result.reason}`);
      continue;
    }
    const existing = byName.get(result.skill.name);
    if (existing) {
      throw new SkillNameCollisionError(result.skill.name, [existing.sourcePath, result.skill.sourcePath]);
    }
    byName.set(result.skill.name, result.skill);
    resolved.push(result.skill);
  }
  return resolved;
}

/**
 * Synchronous variant of `parseSkillFrontmatter` exposed so callers (e.g.
 * dev tooling) can validate SKILL.md content without going through the async
 * file path. Kept here so the parser implementation stays single-sourced.
 */
export function readSkillFrontmatterSync(skillFile: string): SkillFrontmatter | null {
  try {
    const content = readFileSync(skillFile, 'utf-8');
    return parseSkillFrontmatter(content);
  } catch {
    return null;
  }
}
