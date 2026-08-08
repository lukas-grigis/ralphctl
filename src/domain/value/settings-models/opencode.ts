// Verified against the live CLI (`opencode models`, opencode-ai v1.18.15, 2026-08-08).
// Docs: https://opencode.ai/docs/cli/

/**
 * Models supported by the OpenCode adapter.
 *
 * OpenCode is an **aggregator**, not a single-vendor backend: model ids are `provider/model`
 * and the reachable set depends on which upstream providers the operator has authenticated via
 * `opencode providers`. That makes a static catalog structurally different here than for the
 * other three backends, whose catalogs are the vendor's own fixed list.
 *
 * This catalog is therefore the **zero-auth baseline** — the `opencode/*` models served on the
 * bundled free tier, which every install can reach with no credentials at all. It is a floor,
 * not a ceiling: {@link createOpencodeModelAvailabilityProbe} shells out to `opencode models`
 * and reports whatever the operator's authenticated providers actually serve (`anthropic/…`,
 * `openai/…`, and so on), so an authenticated operator sees their full set in the picker while
 * an unauthenticated one still sees a working list rather than nothing.
 *
 * Consequence for validation: unlike the codex / claude adapters, the OpenCode adapter does NOT
 * reject ids outside this list. Doing so would make every authenticated model un-runnable. The
 * adapter forwards `session.model` verbatim and lets the CLI arbitrate, matching the policy the
 * codex adapter already applies to reasoning-effort levels.
 *
 * The free tier rotates as OpenCode swaps in new community models — entries that disappear
 * upstream simply stop being offered by the probe, so a stale line here degrades to a picker
 * entry the CLI rejects, never a crash.
 *
 * Catalog membership means "advertised", NOT "known-healthy": a listed id can still fail at
 * invocation with an upstream `401` while its siblings serve normally (observed for
 * `opencode/north-mini-code-free` on opencode-ai v1.18.15, 2026-08-08). `opencode models` keeps
 * listing such ids, so enumeration is not a liveness check — health-probe before promoting an
 * id to a shipped default.
 */
export type OpencodeModel =
  | 'opencode/big-pickle'
  | 'opencode/deepseek-v4-flash-free'
  | 'opencode/laguna-s-2.1-free'
  | 'opencode/ling-3.0-tiny-free'
  | 'opencode/longcat-2.0-free'
  | 'opencode/mimo-v2.5-free'
  | 'opencode/nemotron-3-ultra-free'
  | 'opencode/north-mini-code-free';

export const OPENCODE_MODELS: readonly OpencodeModel[] = [
  'opencode/big-pickle',
  'opencode/deepseek-v4-flash-free',
  'opencode/laguna-s-2.1-free',
  'opencode/ling-3.0-tiny-free',
  'opencode/longcat-2.0-free',
  'opencode/mimo-v2.5-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/north-mini-code-free',
] as const;

/**
 * Narrow to a catalogued free-tier id — i.e. "is this one of the ids ralphctl itself ships as a
 * known-good default?".
 *
 * Its only consumer is the preset lockstep test, which asserts that every OpenCode row the harness
 * itself authors (preset matrices and the shipped defaults) names an id in {@link OPENCODE_MODELS}.
 * That is why it survives dead-code cleanup: nothing in `src/` calls it, and nothing should.
 *
 * Deliberately NOT an adapter-side gate — see the validation note on {@link OpencodeModel}: the
 * adapters must accept authenticated upstream ids, so their boundary check is the shape-only
 * {@link isOpencodeModelIdShape}.
 *
 * @public
 */
export const isOpencodeModel = (s: string): s is OpencodeModel => (OPENCODE_MODELS as readonly string[]).includes(s);

/**
 * The single spelling of "is this a well-formed OpenCode model id?" — two or more `/`-separated,
 * whitespace-free segments. Shared by the adapter boundary (`opencode/headless.ts`,
 * `opencode/interactive.ts`), which rejects operator-supplied ids before they reach the CLI, and by
 * the availability probe, which filters `opencode models` output. One predicate on purpose: a probe
 * that admitted an id the adapter then refused to run would offer un-runnable picker entries.
 *
 * Multi-segment ids are expected, not tolerated: `opencode models` prints `${providerID}/${modelID}`
 * verbatim, and aggregator model keys routinely carry their own slash — OpenRouter ids are three
 * segments (`openrouter/moonshotai/kimi-k2`), and a custom provider declaring a slashed model id
 * yields `myprovider/vendor/slashed-model`. Verified against opencode-ai v1.18.15. Never narrow this
 * to exactly two segments.
 *
 * Both anchors are load-bearing. `^` rejects the common paste-o of a bare `gpt-5.5` from another
 * backend's catalog, which otherwise produces an opaque CLI error. `$` rejects trailing junk, which
 * is what disqualifies `Available models:`-style banner lines in the probe's stdout.
 */
export const isOpencodeModelIdShape = (s: string): boolean => /^[^/\s]+(?:\/[^/\s]+)+$/.test(s);
