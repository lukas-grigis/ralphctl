import type { ModelAvailabilityProbe } from '@src/integration/ai/providers/_engine/model-availability-probe.ts';

/**
 * Copilot model-availability probe — passthrough for v1. Returns the catalog reference unchanged
 * (fail open by construction).
 *
 * TODO(copilot-probe v2): the real source is the Copilot models API
 * (`api.githubcopilot.com/models`), which returns the account's enabled models. A headless probe
 * was investigated (2026-06-10) and found NOT robustly buildable today — keeping passthrough is a
 * deliberate decision, not an oversight:
 *   1. No on-disk model cache exists (unlike Codex's `~/.codex/models_cache.json`); the model ids
 *      only appear in per-session `~/.copilot/session-state/<id>/events.jsonl`, not a catalog list.
 *   2. The CLI's GitHub OAuth token lives in the OS keychain (service `copilot-cli`), not a file —
 *      extraction is platform-specific (macOS `security`, Linux libsecret, Windows cred manager),
 *      a poor fit for a cross-platform tool.
 *   3. The `models` API needs a Copilot bearer token minted by an undocumented token-exchange
 *      endpoint. The known path (`api.github.com/copilot_internal/v2/token`) and host variants all
 *      404 as of CLI 0.0.417 (the keychain token itself is valid — `api.github.com/user` → 200),
 *      and the CLI ships as a compiled binary so the current endpoint isn't recoverable from source.
 * Net: a reverse-engineered probe would be brittle, macOS-only, and — because this port fails open —
 * would silently fall back to the full catalog on every drift anyway. Revisit only if GitHub ships a
 * documented models-list endpoint, a headless token path, or an on-disk model cache. Until then the
 * static catalog (the official supported-models list) is the picker source; the wiring matches the
 * other providers so the upgrade stays a one-file change.
 *
 * @public
 */
export const copilotModelAvailabilityProbe: ModelAvailabilityProbe = {
  async availableModels(catalog: readonly string[]): Promise<readonly string[]> {
    return catalog;
  },
};
