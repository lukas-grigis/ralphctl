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
 * Flow per manifest entry (`scripts/skills-sources.json`):
 *   1. fetch the raw SKILL.md from raw.githubusercontent.com (Node built-in fetch, no `gh`, no
 *      token — public repos only).
 *   2. compare against the cached copy and print DRIFTED / UNCHANGED.
 *   3. overwrite the cached copy with the freshly fetched content.
 *
 * Exit codes: 1 if ANY fetch errored (so CI / a maintainer notices a dead upstream), 0 otherwise
 * — drift alone never fails the run; the whole point is to surface drift for human review.
 *
 * Dev-only: lives under `scripts/` (a knip entry, never a tsup entry, excluded from the published
 * `files` allow-list), so it ships to no consumer.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MANIFEST_PATH = join(ROOT, 'scripts', 'skills-sources.json');
const VENDOR_ROOT = join(ROOT, 'scripts', 'vendor', 'skills');

/** One upstream-derived bundled skill and where its source SKILL.md lives. */
export interface SkillSource {
  /** The `ralphctl-` bundled folder name (matches `src/.../bundled/<name>/`). */
  readonly name: string;
  /** GitHub `owner/repo`. */
  readonly repo: string;
  /** Path to SKILL.md inside the upstream repo. */
  readonly path: string;
  /** Git ref to pin the fetch to (typically `main`). */
  readonly ref: string;
  /** Upstream license identifier (recorded for attribution). */
  readonly license: string;
  /** Human-facing upstream repo URL. */
  readonly upstreamUrl: string;
}

/** Drift verdict for one skill, comparing freshly fetched content against the cached copy. */
export type DriftStatus = 'DRIFTED' | 'UNCHANGED';

/**
 * Build the raw.githubusercontent.com URL for a manifest entry. Pure — no IO — so it can be
 * unit-tested without a network round-trip.
 */
export const buildRawUrl = (entry: SkillSource): string =>
  `https://raw.githubusercontent.com/${entry.repo}/${entry.ref}/${entry.path}`;

/**
 * Compare freshly fetched content against the cached copy. `undefined` cached (no prior cache
 * file) counts as DRIFTED so the first sync always reports a change. Pure — no IO.
 */
export const diffStatus = (fetched: string, cached: string | undefined): DriftStatus =>
  cached === fetched ? 'UNCHANGED' : 'DRIFTED';

interface Manifest {
  readonly skills: readonly SkillSource[];
}

const readManifest = async (): Promise<Manifest> => {
  const raw = await readFile(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw) as Manifest;
};

/** Read the cached SKILL.md if present; `undefined` on first sync (no file yet). */
const readCached = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
};

const main = async (): Promise<void> => {
  const manifest = await readManifest();
  let anyError = false;

  for (const entry of manifest.skills) {
    const url = buildRawUrl(entry);
    let fetched: string;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        anyError = true;
        console.error(`[skills:update] ${entry.name}: fetch failed (${String(res.status)}) ${url}`);
        continue;
      }
      fetched = await res.text();
    } catch (cause) {
      anyError = true;
      const reason = cause instanceof Error ? cause.message : String(cause);
      console.error(`[skills:update] ${entry.name}: fetch errored — ${reason} (${url})`);
      continue;
    }

    // Guard the manifest-supplied name before it becomes a path segment: a malformed or templated
    // entry (slashes, `..`, leading dot) could otherwise write the cache outside VENDOR_ROOT.
    if (!/^[\w-]+$/.test(entry.name)) {
      throw new Error(`[skills:update] invalid skill name in manifest: ${JSON.stringify(entry.name)}`);
    }

    const cachePath = join(VENDOR_ROOT, entry.name, 'SKILL.md');
    const cached = await readCached(cachePath);
    const status = diffStatus(fetched, cached);

    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, fetched, 'utf8');

    console.log(`[skills:update] ${status} ${entry.name}`);
  }

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
