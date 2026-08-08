/**
 * Alias for the shared {@link SkillsAdapterDeps} shape, kept under the OpenCode-specific name so
 * `skills/opencode/adapter.ts` (a sibling-isolated per-tool directory) doesn't need to import a
 * differently-named type than its claude / copilot / codex counterparts expect of their own alias
 * files. See `skills-adapter-deps.ts` for the single canonical interface body.
 */
export type { SkillsAdapterDeps as CreateOpencodeSkillsAdapterDeps } from '@src/integration/ai/skills/_engine/skills-adapter-deps.ts';
