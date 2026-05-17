/**
 * `build-assets.ts` — copy non-code assets (prompt templates, bundled skills)
 * from `src/integration/ai/` into `dist/` so the published `dist/cli.mjs` can
 * locate them at runtime via the bundle-mode branches in
 * `fs-template-loader.ts` and `skills/bundled/source.ts`.
 *
 * Output layout (must stay in lockstep with those two loader modules):
 *
 *   dist/cli.mjs                              ← tsup output
 *   dist/prompts/<flow>/template.md           ← per-flow prompt templates
 *   dist/prompts/_partials/<name>.md          ← cross-cutting partials
 *   dist/skills/<name>/SKILL.md               ← bundled skill bodies
 *   dist/manifest.json                        ← startup integrity check
 *
 * The manifest is the runtime "did the build complete?" gate — a partial copy
 * silently producing a bundle that serves empty prompts is the failure mode
 * we're guarding against. Run after `tsup` has produced `dist/cli.mjs`.
 * Idempotent: re-running cleans `dist/prompts/` + `dist/skills/` before re-copying.
 */

import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = join(ROOT, 'dist');
const PROMPTS_SRC = join(ROOT, 'src/integration/ai/prompts');
const SKILLS_SRC = join(ROOT, 'src/integration/ai/skills/bundled');

if (!existsSync(DIST)) {
  console.error(`[build-assets] dist/ not found at ${DIST} — run \`tsup\` first.`);
  process.exit(1);
}

await rm(join(DIST, 'prompts'), { recursive: true, force: true });
await rm(join(DIST, 'skills'), { recursive: true, force: true });
await mkdir(join(DIST, 'prompts'), { recursive: true });
await mkdir(join(DIST, 'skills'), { recursive: true });

const assets: string[] = [];

// Prompts: copy every .md under src/integration/ai/prompts/ preserving subdirectory layout.
//   <flow>/template.md     → dist/prompts/<flow>/template.md
//   _partials/<name>.md    → dist/prompts/_partials/<name>.md
const promptFiles = (await walkFiles(PROMPTS_SRC)).filter((p) => p.endsWith('.md'));
if (promptFiles.length === 0) {
  console.error(`[build-assets] no prompt templates found under ${PROMPTS_SRC}`);
  process.exit(1);
}
for (const absSrc of promptFiles) {
  const rel = relative(PROMPTS_SRC, absSrc);
  const dst = join(DIST, 'prompts', rel);
  await mkdir(dirname(dst), { recursive: true });
  await cp(absSrc, dst);
  assets.push(relative(DIST, dst));
}

// Skills: copy each SKILL.md folder under src/integration/ai/skills/bundled/.
//   <name>/SKILL.md        → dist/skills/<name>/SKILL.md
// (Sibling .ts files like source.ts are excluded — they're the adapter, not the asset.)
const skillEntries = await readdir(SKILLS_SRC, { withFileTypes: true });
for (const entry of skillEntries) {
  if (!entry.isDirectory()) continue;
  const skillDir = join(SKILLS_SRC, entry.name);
  const dstDir = join(DIST, 'skills', entry.name);
  await cp(skillDir, dstDir, { recursive: true });
  for (const f of await walkFiles(dstDir)) {
    assets.push(relative(DIST, f));
  }
}

assets.sort();

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  assets,
};
const manifestPath = join(DIST, 'manifest.json');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`[build-assets] wrote ${String(assets.length)} asset(s) + manifest.json under ${relative(ROOT, DIST)}/`);

/**
 * Recursively yield every file under `dir`. Hidden entries (starting with `.`) and dotfile
 * leaves are excluded so accidental editor / Git turds inside a skill folder don't bloat
 * the manifest.
 */
async function walkFiles(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(abs)));
    } else if (e.isFile()) {
      out.push(abs);
    } else {
      // Symlinks, FIFOs, etc. — fall through to stat to be sure.
      try {
        const s = await stat(abs);
        if (s.isFile()) out.push(abs);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}
