/**
 * Alias for the shared {@link SkillsAdapterDeps} shape, kept under the Grok-specific name so
 * `skills/grok/adapter.ts` (a sibling-isolated per-tool directory) doesn't need to import a
 * differently-named type than its claude / copilot / codex / opencode counterparts expect of
 * their own alias files. See `skills-adapter-deps.ts` for the single canonical interface body.
 */
export type { SkillsAdapterDeps as CreateGrokSkillsAdapterDeps } from '@src/integration/ai/skills/_engine/skills-adapter-deps.ts';
