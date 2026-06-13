/**
 * Single reversible kill-switch for models that are temporarily unusable server-side while still
 * carried in the provider catalogs. As of 2026-06-12 the `claude-fable-5` family (Fable 5 /
 * Mythos 5) is suspended by an Anthropic export-control directive; the bare `claude-fable-5`
 * string also matches the Copilot catalog entry (Anthropic-served via Copilot, so it is down too).
 *
 * The catalog entries deliberately STAY in place: the suspension is described as temporary, and the
 * `settings` model fields accept any catalog id OR a custom string (`z.union([z.enum(...),
 * CustomModelStringSchema])`), so already-persisted configs that name a suspended model remain
 * schema-valid. Rather than churn the catalog, the adapters fail fast with a clear message and the
 * model pickers flag the entry — all gated on this one list.
 *
 * To fully restore a model: empty {@link SUSPENDED_MODELS} (or delete this module and its four
 * consumers — the two adapter guards in `claude/headless.ts` + `copilot/headless.ts`, and the two
 * picker annotations in `flows-customize-picker.ts` + `settings-editor.tsx`). Re-enabling is a
 * one-line revert.
 *
 * Domain layer — pure, no I/O.
 *
 * @public
 */
export const SUSPENDED_MODELS: readonly string[] = ['claude-fable-5', 'claude-fable-5[1m]'] as const;

/**
 * `true` when `s` names a temporarily-suspended model (see {@link SUSPENDED_MODELS}).
 *
 * @public
 */
export const isSuspendedModel = (s: string): boolean => SUSPENDED_MODELS.includes(s);

/**
 * Short suffix tag appended to a suspended model's label in the pickers (the value stays the bare
 * id so a pre-pinned choice still round-trips).
 *
 * @public
 */
export const SUSPENSION_NOTE = 'suspended';

/**
 * The launch-time rejection message for a suspended model — surfaced via `InvalidStateError` at the
 * adapter boundary so the user gets actionable context rather than an opaque CLI failure.
 *
 * @public
 */
export const suspendedModelMessage = (model: string): string =>
  `'${model}' is temporarily suspended by Anthropic (2026-06-12 export-control directive on Fable 5 / Mythos 5) — pick another model until access is restored`;
