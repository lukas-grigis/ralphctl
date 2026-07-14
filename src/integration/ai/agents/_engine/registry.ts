/**
 * `BUNDLED_AGENT_DEFINITIONS` — the vetted set of shipped agent definitions, one entry per
 * `bundled/<name>.md` file. Unlike `BUNDLED_SKILLS` (which assigns each skill to a set of
 * flows), agent definitions are not flow-scoped — every entry here is always available for
 * install, regardless of which flow is running.
 *
 * Each name must match a `bundled/<name>.md` file exactly, `ralphctl-` prefix included, and
 * that file's frontmatter `name` must match too (`parseAgentDefinition` asserts this). The
 * registry test (`tests/unit/integration/ai/agents/registry.test.ts`) fences the on-disk half
 * of that invariant: every name here resolves to a bundled file.
 */
export const BUNDLED_AGENT_DEFINITIONS: readonly string[] = ['ralphctl-evaluator', 'ralphctl-generator'];
