/**
 * Canonical AgentDefinition type — the single shape every source produces and every provider
 * renderer consumes for the portable-agent-definitions subsystem.
 *
 * An AgentDefinition is a named sub-agent persona (system prompt + optional model/effort
 * hints) an AI session can delegate to. The content is provider-agnostic Markdown; the
 * *placement* (where the file lands so the AI's CLI auto-discovers it) is up to the
 * per-provider renderer.
 *
 * Source-of-truth file format on disk — Markdown with YAML frontmatter:
 *
 *     ---
 *     name: implementer
 *     description: Writes features, fixes bugs, adds tests
 *     model: claude-sonnet-5
 *     effort: high
 *     ---
 *     <content>
 *
 * `name` is the kebab-case identifier (and source file name on disk).
 */

import { z } from 'zod';

/** Prefix applied to ralphctl-authored agent definitions so they are namespaced on disk. @public */
export const RALPHCTL_AGENT_PREFIX = 'ralphctl-';

/**
 * Idempotent prefixing for a native-render file base name. The bundled and operator sources
 * already namespace `AgentDefinition.name` with {@link RALPHCTL_AGENT_PREFIX} (mirroring
 * `Skill.name`'s convention), so a per-provider renderer that unconditionally prepended the
 * prefix again would double it (`ralphctl-ralphctl-<name>`). Every renderer calls this instead
 * of concatenating the prefix directly, so a bare (un-namespaced) name — as used by the
 * renderer unit tests and any future direct caller — still gets prefixed exactly once.
 *
 * @public
 */
export const namespacedAgentFileBase = (name: string): string =>
  name.startsWith(RALPHCTL_AGENT_PREFIX) ? name : `${RALPHCTL_AGENT_PREFIX}${name}`;

/**
 * Agent definition name = kebab-case identifier. Must match the source file name on disk so
 * the file layout and the frontmatter agree.
 */
export const AgentDefinitionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens');

/**
 * On-disk frontmatter shape. `name` and `description` are required. `model` and `effort` are
 * passed through verbatim as opaque strings — the caller resolves them against each provider's
 * own model/effort vocabulary; this layer does not validate their values.
 */
export const AgentDefinitionFrontmatterSchema = z.object({
  name: AgentDefinitionNameSchema,
  description: z.string().min(1).max(1024),
  model: z.string().optional(),
  effort: z.string().optional(),
});

export interface AgentDefinition {
  /** Kebab-case identifier. Also the on-disk source file name. */
  readonly name: string;
  /** One-line "what + when to use" — drives both human readers and AI delegation. */
  readonly description: string;
  /** Optional preferred model identifier, opaque to this layer. */
  readonly model?: string;
  /** Optional preferred reasoning-effort hint, opaque to this layer. */
  readonly effort?: string;
  /** Markdown body (everything after the frontmatter block) — the agent's system prompt. */
  readonly content: string;
}

/** Output of a per-provider native renderer — {@link RALPHCTL_AGENT_PREFIX}-prefixed file. */
export interface RenderedAgentFile {
  /** Path relative to `sessionDir`, including the provider's parent directory. */
  readonly relPath: string;
  readonly content: string;
}
