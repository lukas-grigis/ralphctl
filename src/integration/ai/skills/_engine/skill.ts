/**
 * Canonical Skill type — the single shape every source produces and every adapter consumes.
 * Aligned with the Agent Skills open standard (https://agentskills.io/specification), which
 * Claude Code, GitHub Copilot, and OpenAI Codex all claim compatibility with.
 *
 * A Skill is a piece of advice / convention / coding-agent guidance the AI session can
 * discover at runtime. The content is provider-agnostic Markdown; the *placement* (where the
 * file lands so the AI's CLI auto-discovers it) is up to the per-provider {@link SkillsAdapter}.
 *
 * Source-of-truth file format on disk — Markdown with YAML frontmatter:
 *
 *     ---
 *     name: alignment
 *     description: Confirm scope before diving into work
 *     ---
 *     <body>
 *
 * `name` is the kebab-case identifier (and folder name on disk). There is no separate display
 * name in the spec — `description` carries the human-readable text. A skill is the whole folder:
 * `SKILL.md` plus optional `references/`, `scripts/` and `assets/` the body points into, which
 * the model loads on demand (progressive disclosure).
 */

import { z } from 'zod';

/**
 * Skill name = kebab-case identifier. Must match the parent directory name on disk so the
 * folder layout and the frontmatter agree. Constraints come from the Agent Skills spec.
 */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens');

/**
 * On-disk frontmatter shape. `name` and `description` are required by the spec; `license`,
 * `compatibility` and `allowed-tools` are typed spec fields. Every other key (`metadata`, provider
 * keys such as `disable-model-invocation`) passes through untouched so the installed copy keeps it.
 */
export const SkillFrontmatterSchema = z.looseObject({
  name: SkillNameSchema,
  description: z.string().trim().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  'allowed-tools': z.string().optional(),
});

/** Frontmatter keys {@link Skill} carries as typed fields; anything else lands in `extraFrontmatter`. */
export const TYPED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'allowed-tools',
]);

/**
 * Top-level folders of a skill that travel with its `SKILL.md` (Agent Skills layout). Anything
 * else in a skill folder — sidecars, editor cruft, provider-specific files — is never read or copied.
 */
export const SKILL_SUPPORT_DIRS = ['references', 'scripts', 'assets'] as const;

/** One support file of a skill folder, e.g. `references/checklist.md` or `assets/logo.png`. */
export interface SkillFile {
  /** Forward-slash path relative to the skill folder; always under a {@link SKILL_SUPPORT_DIRS} entry. */
  readonly path: string;
  /** Decoded text for a UTF-8 file; the raw bytes for anything else (images, fonts). */
  readonly content: string | Uint8Array;
  /** Set when the source file had an execute bit, so an installed `scripts/` file stays runnable. */
  readonly executable?: true;
}

export interface Skill {
  /** Kebab-case identifier. Also the on-disk folder name. */
  readonly name: string;
  /** One-line "what + when to use" — drives both human readers and AI auto-invocation. */
  readonly description: string;
  /** Optional spec field — license name or reference. */
  readonly license?: string;
  /** Optional spec field — environment requirements (≤500 chars). */
  readonly compatibility?: string;
  /** Optional spec field — space-separated pre-approved tools (experimental in the spec). */
  readonly allowedTools?: string;
  /** Every other frontmatter key, as YAML typed it (`metadata`, `disable-model-invocation`, …). */
  readonly extraFrontmatter?: Readonly<Record<string, unknown>>;
  /** Markdown body (everything after the frontmatter block). */
  readonly content: string;
  /** Support files installed next to `SKILL.md` (`references/`, `scripts/`, `assets/`), sorted by path. */
  readonly files?: readonly SkillFile[];
}
