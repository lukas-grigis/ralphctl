import type { z } from 'zod';
import type { AiSignal } from '@src/domain/signal.ts';

/**
 * Rule for rendering one AI-produced signal kind into an operator-readable sidecar file.
 *
 * - `signalKind` discriminates which signal in the validated array drives this rule.
 * - `filename` is rendered relative to the spawn's `outputDir`.
 * - `extract(signal)` produces the file body (string). The leaf's `WriteFile` adapter writes
 *   the result verbatim — no escape gymnastics, no further transform.
 * - `multiplicity` is the per-spawn occurrence count:
 *     'one'      → exactly one signal of this kind MUST exist (Zod schema enforces upstream);
 *     'optional' → at most one (no file written if absent);
 *     'any'      → render every occurrence; current contracts do not use this.
 *
 * Generic `TKind` narrows `signal` inside `extract` to the matching variant of `AiSignal`.
 */
export interface SidecarRule<TKind extends AiSignal['type'] = AiSignal['type']> {
  readonly signalKind: TKind;
  readonly filename: string;
  readonly extract: (signal: Extract<AiSignal, { type: TKind }>) => string;
  readonly multiplicity: 'one' | 'optional' | 'any';
}

/**
 * One step in a contract's migration chain. Each step transforms the raw parsed JSON for a
 * single version transition (`fromVersion → fromVersion + 1`). Steps are pure functions —
 * they take `unknown` and return `unknown` so the chain can compose without intermediate
 * Zod parses. The final step's output is what the contract's `signalsSchema` parses.
 */
export type AiSignalsFileMigration = (raw: unknown) => unknown;

/**
 * Per-leaf I/O contract under audit [09]. Composed by per-leaf `<leaf>.contract.ts` files
 * from the engine building blocks under `_engine/`. The leaf never reaches into per-signal
 * schemas directly — that fence is enforced separately.
 *
 * Shape on disk (the validator parses bytes matching this wrapper):
 *
 *   { schemaVersion: number, signals: AiSignal[] }
 *
 * `signalsSchema` is the Zod parser for the inner `signals` array. `migrations[v]` runs at
 * load time when an on-disk file declares a `schemaVersion` lower than `schemaVersion`; the
 * walker iterates `v ∈ [fileVersion, schemaVersion)` and aborts with `MigrationGapError` if
 * any step is missing.
 *
 * `TSig` lets each leaf pin its accepted sub-union of `AiSignal` so the validator's return
 * type is precise and `renderSidecars` is type-safe end-to-end.
 */
export interface AiOutputContract<TSig extends AiSignal = AiSignal> {
  readonly schemaVersion: number;
  readonly signalsSchema: z.ZodType<readonly TSig[]>;
  readonly sidecars: ReadonlyArray<SidecarRule<TSig['type']>>;
  readonly migrations: Readonly<Record<number, AiSignalsFileMigration>>;
  /**
   * Representative signal payload embedded in the rendered `{{OUTPUT_CONTRACT_SECTION}}` block.
   * One example per contract (one per leaf), hand-authored to cover the kinds the AI is most
   * likely to emit. Prompt unit tests round-trip this through `signalsSchema` to catch drift
   * the moment the schema's accepted shape diverges from what the prompt documents.
   */
  readonly exampleSignals: readonly TSig[];
}

/**
 * Shape of the on-disk `signals.json` wrapper — the migration walker accepts any value but
 * the final Zod parse expects `signals` to be `unknown` until validated. Exported so test
 * fixtures and rendered prompt examples share one type.
 *
 * @public
 */
export interface AiSignalsFile {
  readonly schemaVersion: number;
  readonly signals: readonly unknown[];
}
