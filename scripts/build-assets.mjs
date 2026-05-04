#!/usr/bin/env node
/**
 * `build-assets.mjs` — copy non-code assets (prompt templates, default
 * skills) from `src/` into `dist/` and write a `manifest.json` that the
 * bundled CLI uses for boot-time integrity verification.
 *
 * The previous build pipeline embedded this as a long shell command
 * inside `package.json`. That worked but had two problems:
 *  1. No manifest meant a partial copy silently produced a bundle that
 *     served empty prompts at runtime — the CLI doesn't fail until the
 *     AI receives garbage and emits something useless. The CLAUDE.md
 *     "Build & Distribution" gotcha called this out as a known footgun.
 *  2. The pipeline wasn't testable. A typo in the cp arguments would
 *     ship a broken artefact to npm.
 *
 * This script replaces the shell pipeline. The manifest's job is
 * narrow: list every file we copied into `dist/` so the runtime
 * verifier (`src/integration/ai/dist-asset-manifest.ts`) can stat each
 * one at startup and fail fast with a clear message when the bundle is
 * incomplete.
 *
 * Idempotent: re-running cleans `dist/prompts/` and `dist/skills/`
 * before recopying. Safe to invoke from the `pnpm build` script after
 * `tsup` has produced `dist/cli.mjs`.
 */
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = join(ROOT, 'dist');
const PROMPTS_SRC = join(ROOT, 'src/integration/ai/prompts/templates');
const SKILLS_SRC = join(ROOT, 'src/integration/ai/skills');
/**
 * Phases the build copies into `dist/skills/`. Mirrors
 * `BundledSkillsCopier.SkillsPhase` in the runtime — keep this list in
 * lockstep with the source-tree layout.
 */
const SKILLS_PHASES = ['default', 'refine', 'plan', 'exec'];

if (!existsSync(DIST)) {
  console.error(`[build-assets] dist/ not found at ${DIST} — run \`tsup\` first.`);
  process.exit(1);
}

await rm(join(DIST, 'prompts'), { recursive: true, force: true });
await rm(join(DIST, 'skills'), { recursive: true, force: true });
await mkdir(join(DIST, 'prompts'), { recursive: true });
await mkdir(join(DIST, 'skills'), { recursive: true });

/** @type {string[]} */
const assets = [];

const promptFiles = (await readdir(PROMPTS_SRC)).filter((f) => f.endsWith('.md'));
if (promptFiles.length === 0) {
  console.error(`[build-assets] no prompt templates found under ${PROMPTS_SRC}`);
  process.exit(1);
}
for (const file of promptFiles) {
  const dst = join(DIST, 'prompts', file);
  await cp(join(PROMPTS_SRC, file), dst);
  assets.push(relative(DIST, dst));
}

for (const phase of SKILLS_PHASES) {
  const src = join(SKILLS_SRC, phase);
  if (!existsSync(src)) continue;
  const dst = join(DIST, 'skills', phase);
  await cp(src, dst, { recursive: true });
  for (const f of await walkFiles(dst)) {
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
 * Recursively yield every file under `dir`. Hidden entries (starting
 * with `.`) are excluded so accidental dotfiles inside a skill folder
 * don't bloat the manifest.
 *
 * @param {string} dir
 * @returns {Promise<readonly string[]>}
 */
async function walkFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(abs)));
    } else if (e.isFile()) {
      out.push(abs);
    } else {
      // Symlinks, FIFOs, etc. — fall through to a stat to be sure.
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
