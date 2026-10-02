import type { GrokArtifacts } from '@src/integration/ai/readiness/grok/artifacts.ts';
import { createAgentsMdProbe } from '@src/integration/ai/readiness/_engine/agents-md-probe.ts';
import type { ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';

/** Filesystem probe for Grok artifacts: `AGENTS.md` + `.grok/skills/<name>/SKILL.md`. */
export const grokProbe: ReadinessProbe<GrokArtifacts> = createAgentsMdProbe<GrokArtifacts>('grok');
