import type { CodexArtifacts } from '@src/integration/ai/readiness/codex/artifacts.ts';
import { createAgentsMdProbe } from '@src/integration/ai/readiness/_engine/agents-md-probe.ts';
import type { ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';

/** Filesystem probe for Codex artifacts: `AGENTS.md` + `.agents/skills/<name>/SKILL.md`. */
export const codexProbe: ReadinessProbe<CodexArtifacts> = createAgentsMdProbe<CodexArtifacts>('codex');
