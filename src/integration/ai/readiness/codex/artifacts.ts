/**
 * Codex artifact catalog — placeholder until the on-disk signature is finalized. The probe
 * returns `unknown` for now (see `ai/readiness/<tool>/codex-probe.ts`); when the
 * shape stabilizes, fields go here.
 */
export interface CodexArtifacts {
  readonly tool: 'codex';
}
