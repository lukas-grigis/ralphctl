/**
 * `sync-skills.ts` — maintainer-only tooling (run via `pnpm skills:update`).
 *
 * Bundled skills under `src/integration/ai/skills/bundled/<name>/SKILL.md` are FROZEN committed
 * source: each upstream-derived skill carries hand-applied de-JS / compatibility adaptations that
 * a blind overwrite would clobber. This script does NOT touch them. Instead it refreshes a
 * committed raw-upstream cache at `scripts/vendor/skills/<name>/SKILL.md` so that
 * `git diff scripts/vendor/` shows exactly what changed upstream since the last sync. The
 * maintainer then re-applies the adaptation to the live bundled file by hand.
 *
 * Flow:
 *   0. Zod-validate the manifest (`scripts/skills-sources.json`) BEFORE any network call or write.
 *   1. Resolve each distinct repo@ref to a commit SHA (GitHub commits API; `GITHUB_TOKEN` is used
 *      when set, to dodge the anonymous rate limit) and fetch every file at that SHA, so a sync is
 *      reproducible. `--locked` reuses the SHAs from `scripts/vendor/skills/skills-lock.json`
 *      instead of resolving the ref again.
 *   2. Per entry: SKILL.md plus the optional `extraPaths` (sibling / references `.md` files,
 *      relative to the skill's upstream folder) are compared to the cache and cached under
 *      `scripts/vendor/skills/<name>/<relative path>`. Never `agents/*.yaml` or scripts.
 *   3. The lock file records repo, ref, SHA and file list per skill, so `git diff scripts/vendor/`
 *      is attributable to an upstream commit range.
 *   4. A 404 prints the last commit that touched the path, to spot upstream renames / removals.
 *
 * Exit codes: 1 if ANY fetch errored (so CI / a maintainer notices a dead upstream), 0 otherwise
 * — drift alone never fails the run; the whole point is to surface drift for human review.
 *
 * Dev-only: lives under `scripts/` (a knip entry, never a tsup entry, excluded from the published
 * `files` allow-list), so it ships to no consumer.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MANIFEST_PATH = join(ROOT, 'scripts', 'skills-sources.json');
const VENDOR_ROOT = join(ROOT, 'scripts', 'vendor', 'skills');
const LOCK_PATH = join(VENDOR_ROOT, 'skills-lock.json');

/** A repo-relative markdown path: no traversal, no absolute path, no agents/ or scripts/ segment. */
const safeMarkdownPath = z
  .string()
  .regex(/\.md$/i, 'must be a .md file')
  .refine((p) => !p.startsWith('/') && !p.includes('\\'), 'must be a relative posix path')
  .refine((p) => !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === ''), 'no traversal')
  .refine(
    (p) => !p.split('/').some((seg) => seg === 'agents' || seg === 'scripts'),
    'agents/ and scripts/ are never synced'
  );

const skillSourceSchema = z.object({
  /** The `ralphctl-` bundled folder name (matches `src/.../bundled/<name>/`). */
  name: z.string().regex(/^ralphctl-[a-z0-9-]+$/, 'must be a ralphctl-<kebab> folder name'),
  /** GitHub `owner/repo`. */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/repo'),
  /** Path to SKILL.md inside the upstream repo. */
  path: safeMarkdownPath,
  /** Git ref to resolve to a SHA at sync time (typically `main`). */
  ref: z.string().min(1),
  /** Upstream license identifier (recorded for attribution). */
  license: z.string().min(1),
  /** Human-facing upstream repo URL. */
  upstreamUrl: z.url(),
  /** Extra `.md` files, relative to the directory of `path` (e.g. `references/x.md`, `DEEPENING.md`). */
  extraPaths: z.array(safeMarkdownPath).optional(),
  /** Maintainer note shown with the entry (adoption caveats). */
  note: z.string().optional(),
});

const manifestSchema = z
  .object({
    $comment: z.string().optional(),
    $cleanRoom: z.array(z.string()).optional(),
    skills: z.array(skillSourceSchema),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const [i, s] of m.skills.entries()) {
      if (seen.has(s.name))
        ctx.addIssue({ code: 'custom', path: ['skills', i, 'name'], message: `duplicate name ${s.name}` });
      seen.add(s.name);
    }
  });

/** One upstream-derived bundled skill and where its source SKILL.md lives. */
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

/** Validate raw manifest JSON; throws with every issue listed. Pure — no IO. */
export const parseManifest = (raw: unknown): Manifest => {
  const res = manifestSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`[skills:update] invalid manifest:\n${issues}`);
  }
  return res.data;
};

/** Names listed in `$cleanRoom` strings (each entry starts with the bundled folder name). */
export const cleanRoomNames = (manifest: Manifest): string[] =>
  (manifest.$cleanRoom ?? []).flatMap((line) => {
    const m = /^(ralphctl-[a-z0-9-]+)/.exec(line);
    return m?.[1] ? [m[1]] : [];
  });

/** Drift verdict for one skill, comparing freshly fetched content against the cached copy. */
export type DriftStatus = 'DRIFTED' | 'UNCHANGED';

/** One file to sync: cache-relative path (under `<name>/`) and the upstream repo path. */
export interface SyncFile {
  readonly rel: string;
  readonly upstreamPath: string;
}

/** SKILL.md first, then each extra path resolved against the upstream skill folder. Pure. */
export const skillFiles = (entry: SkillSource): SyncFile[] => [
  { rel: 'SKILL.md', upstreamPath: entry.path },
  ...(entry.extraPaths ?? []).map((extra) => ({
    rel: extra,
    upstreamPath: posix.join(posix.dirname(entry.path), extra),
  })),
];

/**
 * Build the raw.githubusercontent.com URL for a manifest entry. `refOrSha` overrides the manifest
 * ref (the sync passes the resolved SHA); `upstreamPath` overrides the path (extra files). Pure.
 */
export const buildRawUrl = (
  entry: SkillSource,
  refOrSha: string = entry.ref,
  upstreamPath: string = entry.path
): string => `https://raw.githubusercontent.com/${entry.repo}/${refOrSha}/${upstreamPath}`;

/**
 * Compare freshly fetched content against the cached copy. `undefined` cached (no prior cache
 * file) counts as DRIFTED so the first sync always reports a change. Pure — no IO.
 */
export const diffStatus = (fetched: string, cached: string | undefined): DriftStatus =>
  cached === fetched ? 'UNCHANGED' : 'DRIFTED';

/** Shape of the lock file: one pinned SHA per skill. */
export interface SkillsLock {
  readonly version: 1;
  readonly skills: Record<string, { repo: string; ref: string; sha: string; files: string[] }>;
}

const lockSchema = z.object({
  version: z.literal(1),
  skills: z.record(
    z.string(),
    z.object({ repo: z.string(), ref: z.string(), sha: z.string(), files: z.array(z.string()) })
  ),
});

/** Stable serialisation (sorted keys, trailing newline) so lock diffs are minimal. Pure. */
export const serializeLock = (lock: SkillsLock): string => {
  const sorted: SkillsLock = {
    version: 1,
    skills: Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b))),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
};

/** Format the commits-API answer for a 404 hint. Pure. */
export const formatCommitHint = (commits: unknown): string => {
  if (!Array.isArray(commits) || commits.length === 0) {
    return 'no commit on this ref ever touched the path (wrong path or repo?)';
  }
  const c = commits[0] as {
    sha?: string;
    html_url?: string;
    commit?: { message?: string; committer?: { date?: string } };
  };
  const subject = (c.commit?.message ?? '').split('\n')[0] ?? '';
  return `last commit touching the path: ${(c.sha ?? '?').slice(0, 12)} ${c.commit?.committer?.date ?? ''} "${subject}" ${c.html_url ?? ''} — likely renamed or removed there`.replace(
    /\s+/g,
    ' '
  );
};

const githubHeaders = (accept: string): Record<string, string> => ({
  Accept: accept,
  'User-Agent': 'ralphctl-skills-sync',
  ...(process.env['GITHUB_TOKEN'] ? { Authorization: `Bearer ${process.env['GITHUB_TOKEN']}` } : {}),
});

const resolveSha = async (repo: string, ref: string): Promise<string> => {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: githubHeaders('application/vnd.github.sha'),
  });
  if (!res.ok) throw new Error(`cannot resolve ${repo}@${ref} (${String(res.status)})`);
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected SHA answer for ${repo}@${ref}`);
  return sha;
};

const commitHint = async (repo: string, ref: string, path: string): Promise<string> => {
  try {
    const url = `https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&per_page=1`;
    const res = await fetch(url, { headers: githubHeaders('application/vnd.github+json') });
    if (!res.ok) return `commit lookup failed (${String(res.status)})`;
    return formatCommitHint(await res.json());
  } catch (cause) {
    return `commit lookup errored — ${cause instanceof Error ? cause.message : String(cause)}`;
  }
};

const readCached = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
};

const readLock = async (): Promise<SkillsLock> => {
  const raw = await readCached(LOCK_PATH);
  if (raw === undefined) return { version: 1, skills: {} };
  const res = lockSchema.safeParse(JSON.parse(raw));
  if (!res.success) throw new Error(`[skills:update] invalid ${LOCK_PATH}`);
  return res.data;
};

const main = async (): Promise<void> => {
  const manifest = parseManifest(JSON.parse(await readFile(MANIFEST_PATH, 'utf8')));
  const locked = process.argv.includes('--locked');
  const lock = await readLock();
  const nextLock: SkillsLock['skills'] = {};
  const shaByRepoRef = new Map<string, string>();
  let anyError = false;

  for (const entry of manifest.skills) {
    let sha: string;
    try {
      if (locked) {
        const pinned = lock.skills[entry.name];
        if (!pinned) throw new Error('no lock entry (run without --locked first)');
        sha = pinned.sha;
      } else {
        const key = `${entry.repo}@${entry.ref}`;
        const known = shaByRepoRef.get(key);
        sha = known ?? (await resolveSha(entry.repo, entry.ref));
        shaByRepoRef.set(key, sha);
      }
    } catch (cause) {
      anyError = true;
      console.error(`[skills:update] ${entry.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      const prior = lock.skills[entry.name];
      if (prior) nextLock[entry.name] = prior;
      continue;
    }

    const fetchedFiles: { rel: string; text: string }[] = [];
    let entryFailed = false;
    for (const file of skillFiles(entry)) {
      const url = buildRawUrl(entry, sha, file.upstreamPath);
      try {
        const res = await fetch(url);
        if (!res.ok) {
          entryFailed = true;
          const hint = res.status === 404 ? ` — ${await commitHint(entry.repo, entry.ref, file.upstreamPath)}` : '';
          console.error(`[skills:update] ${entry.name}: fetch failed (${String(res.status)}) ${url}${hint}`);
          continue;
        }
        fetchedFiles.push({ rel: file.rel, text: await res.text() });
      } catch (cause) {
        entryFailed = true;
        console.error(
          `[skills:update] ${entry.name}: fetch errored — ${cause instanceof Error ? cause.message : String(cause)} (${url})`
        );
      }
    }

    if (entryFailed) {
      anyError = true;
      const prior = lock.skills[entry.name];
      if (prior) nextLock[entry.name] = prior;
      continue;
    }

    for (const { rel, text } of fetchedFiles) {
      const cachePath = join(VENDOR_ROOT, entry.name, rel);
      const status = diffStatus(text, await readCached(cachePath));
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, text, 'utf8');
      console.log(`[skills:update] ${status} ${entry.name}/${rel}`);
    }
    nextLock[entry.name] = {
      repo: entry.repo,
      ref: entry.ref,
      sha,
      files: fetchedFiles.map((f) => f.rel),
    };
  }

  await mkdir(VENDOR_ROOT, { recursive: true });
  await writeFile(LOCK_PATH, serializeLock({ version: 1, skills: nextLock }), 'utf8');

  if (anyError) {
    console.error('[skills:update] one or more fetches errored — see above.');
    process.exit(1);
  }
};

// ESM main-module guard: run only when invoked directly (`tsx scripts/sync-skills.ts`), not when
// the test suite imports the pure helpers above. Both sides are normalised through fileURLToPath /
// resolve so the comparison holds on Windows (forward vs back slashes) as well as POSIX.
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  await main();
}
