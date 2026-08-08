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
 * known-good default?". Used to validate the rows the harness authors (preset matrices and the
 * shipped defaults), which must stay in lockstep with {@link OPENCODE_MODELS}.
 *
 * Deliberately NOT an adapter-side gate — see the validation note on {@link OpencodeModel}: the
 * adapters must accept authenticated upstream ids, so their boundary check is the permissive
 * {@link isOpencodeModelIdShape}.
 *
 * @public
 */
export const isOpencodeModel = (s: string): s is OpencodeModel => (OPENCODE_MODELS as readonly string[]).includes(s);

/**
 * Every OpenCode model id is `provider/model`. Used to sanity-check operator-supplied ids before
 * they reach the CLI: a bare `gpt-5.5` is a common paste-o from another backend's catalog and
 * produces an opaque CLI error, so the adapter rejects it up front with a message that names the
 * expected shape.
 */
export const isOpencodeModelIdShape = (s: string): boolean => /^[^/\s]+\/[^/\s]+/.test(s);
