import type { OpencodeArtifacts } from '@src/integration/ai/readiness/opencode/artifacts.ts';
import { createAgentsMdProbe } from '@src/integration/ai/readiness/_engine/agents-md-probe.ts';
import type { ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';

/** Filesystem probe for OpenCode artifacts: `AGENTS.md` + `.opencode/skills/<name>/SKILL.md`. */
export const opencodeProbe: ReadinessProbe<OpencodeArtifacts> = createAgentsMdProbe<OpencodeArtifacts>('opencode');
