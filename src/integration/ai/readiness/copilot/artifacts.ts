import type { ArtifactRef } from '@src/integration/ai/readiness/_engine/artifact-ref.ts';

/** Catalog of GitHub Copilot artifacts. v1 only checks the canonical instructions file. */
export interface CopilotArtifacts {
  readonly tool: 'copilot';
  /** `.github/copilot-instructions.md`. */
  readonly copilotInstructions?: ArtifactRef;
}
