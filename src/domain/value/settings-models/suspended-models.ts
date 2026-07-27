/**
 * Single reversible kill-switch for models that are temporarily unusable server-side while still
 * carried in the provider catalogs. The list is deliberately retained as a mechanism even when
 * EMPTY: the 2026-06-12 `claude-fable-5` family (Fable 5 / Mythos 5) Anthropic export-control
 * suspension was lifted when Fable went GA (2026-07), so {@link SUSPENDED_MODELS} is currently
 * empty — but the seam and its four consumers (two adapter guards in `claude/headless.ts` +
 * `copilot/headless.ts`, and the two picker annotations in `flows-customize-picker.ts` +
 * `settings-editor.tsx`) stay wired for the next incident.
 *
 * The catalog entries deliberately STAY in place during a suspension: it is described as
 * temporary, and the `settings` model fields accept any catalog id OR a custom string
 * (`z.union([z.enum(...), CustomModelStringSchema])`), so already-persisted configs that name a
 * suspended model remain schema-valid. Rather than churn the catalog, the adapters fail fast
 * with a clear message and the model pickers flag the entry — all gated on this one list.
 *
 * To suspend a model again: add its id(s) to {@link SUSPENDED_MODELS}. Re-enabling is a
 * one-line revert (empty the array, as done here for Fable 5).
 *
 * Domain layer — pure, no I/O.
 *
 * @public
 */
export const SUSPENDED_MODELS: readonly string[] = [] as const;

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
  `'${model}' is temporarily suspended by its provider — pick another model until access is restored`;
