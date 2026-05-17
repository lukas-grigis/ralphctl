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
 * name in the spec — `description` carries the human-readable text.
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
 * On-disk frontmatter shape. `name` and `description` are required by the spec. The three
 * optional fields are passed through verbatim so adapters can use them when emitting per-
 * provider artifacts. `metadata` (nested map in the spec) is not parsed today — our naive
 * YAML reader handles only flat `key: value` lines; add a real YAML lib when a skill needs it.
 */
export const SkillFrontmatterSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  'allowed-tools': z.string().optional(),
});

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
  /** Markdown body (everything after the frontmatter block). */
  readonly content: string;
}

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
