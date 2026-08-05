import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';

/**
 * Per-role spawn identity + prompt-decoration config for one side of the gen-eval loop (generator
 * or evaluator) — the single definition site for both `gen-eval-loop.ts`'s normal loop and
 * `best-of-n.ts`'s composite. Previously duplicated body-for-body across both files (the round-2+
 * generator/evaluator steps of a best-of-N attempt reuse the exact same leaves the normal loop
 * does), which meant a field added here for one loop silently didn't reach the other unless a
 * maintainer remembered to hand-copy it. See `withRoleSpawn` / `roleSpawnConfig` below.
 */
export interface GenEvalLoopRoleConfig {
  readonly providerId: string;
  readonly model: string;
  readonly effort?: string;
  /**
   * Pre-composed "## Agent Definition" prompt section for this role, resolved once at launch —
   * absent when the role has no bound definition. Threaded into the generator/evaluator leaf as
   * `agentDefinition` and rides only the FULL prompt of a session thread (round 1); a resumed
   * continuation already carries it in-conversation.
   */
  readonly agentDefinitionSection?: string;
  /**
   * This role's bound agent-definition NAME (bare identifier) — threaded into the generator/
   * evaluator leaf as `agentDefinitionName` so the FULL prompt's `{{PROJECT_TOOLING}}` catalog
   * can name the same binding `agentDefinitionSection` already announces in prose. Absent when
   * the role has no bound definition.
   */
  readonly agentDefinitionName?: string;
}

/**
 * Overlay one role's spawn identity — provider port, model, effort — plus its bound agent
 * definition onto the cross-role leaf deps. The agent-definition section and its name ride only
 * when the role has a binding, so an unbound role's leaf deps are byte-for-byte what they were
 * before the portable-agents feature existed.
 */
export const withRoleSpawn = <TShared extends object>(
  shared: TShared,
  provider: HeadlessAiProvider,
  role: GenEvalLoopRoleConfig
) => ({
  ...shared,
  provider,
  model: role.model,
  ...(role.effort !== undefined ? { effort: role.effort } : {}),
  ...(role.agentDefinitionSection !== undefined ? { agentDefinition: role.agentDefinitionSection } : {}),
  ...(role.agentDefinitionName !== undefined ? { agentDefinitionName: role.agentDefinitionName } : {}),
});

/**
 * The provider / model / effort triple a role's spawn runs at, in the shape both attribution
 * sidecars want. Resolved once per role so the generic `meta.json` stamp, the implement-specific
 * `role-meta.json` stamp, and the spawn itself can never disagree about what ran.
 */
export const roleSpawnConfig = (
  role: GenEvalLoopRoleConfig
): { readonly providerId: string; readonly model: string; readonly effort?: string } => ({
  providerId: role.providerId,
  model: role.model,
  ...(role.effort !== undefined ? { effort: role.effort } : {}),
});
