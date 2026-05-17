import type { ClaudeArtifacts } from '@src/integration/ai/readiness/claude/artifacts.ts';
import type { CopilotArtifacts } from '@src/integration/ai/readiness/copilot/artifacts.ts';
import type { CodexArtifacts } from '@src/integration/ai/readiness/codex/artifacts.ts';

/**
 * Discriminated union of every tool's artifact catalog. Adding a new variant flows through
 * every `switch` on `tool` via exhaustiveness checks (`const _exhaustive: never = artifacts`).
 */
export type ToolArtifacts = ClaudeArtifacts | CopilotArtifacts | CodexArtifacts;
