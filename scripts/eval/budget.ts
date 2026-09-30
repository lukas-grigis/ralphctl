/**
 * Pure admission ledger for the eval harness's token / wall-clock budget.
 *
 * Token usage only arrives after a spawn finishes ("Emit one `TokenUsageEvent` per success spawn",
 * `run-provider-attempt.ts:56`), so the budget cannot stop a trial mid-spawn. It is enforced by
 * ADMISSION instead: a trial starts only if `spent + reserve <= maxTokens`, where the reserve is the
 * largest token total seen so far for that flow (or `reserveTokens` before any observation). That
 * policy is engineering judgment — there is no measured per-trial cost to size a default from, which
 * is why `--max-tokens` is required and the ledger fails closed on unmetered trials.
 *
 * WHAT `--max-tokens` BOUNDS: input + cache creation + cache read + output — every token the
 * provider reports for the trial. Engineering judgment: Claude reports cache reads and writes as
 * fields separate from `input_tokens` (`claude/parse-stream.ts` `extractResultUsage`), and on a
 * cached agent turn they dwarf it, so a budget over input + output alone under-counts by orders of
 * magnitude. `input` is the adapter's figure and may already include cache (Codex does; its cache fields stay unset, so nothing is double counted). This is a token volume, not a bill: the price per cache-read / cache-write token
 * differs from plain input and the harness applies no rates.
 *
 * Missing token counts are never imputed (`ProviderUsage` fields are optional — Codex commonly omits
 * them). A trial counts as metered only when both the input and output counts were reported; the
 * reported part still counts toward `spentTokens`. By default an unmetered trial stops the run.
 */

export type StopReason = 'budget' | 'wall' | 'unmetered';

export interface BudgetConfig {
  readonly maxTokens: number;
  /** Reserve assumed for a flow with no completed trial yet. */
  readonly reserveTokens: number;
  readonly maxWallMs?: number;
  readonly allowUnmetered: boolean;
}

export interface TrialCost {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  /** `false` when any spawn of the trial reported no token counts, even if the sums look complete. */
  readonly metered?: boolean;
}

export type Admission = { readonly admitted: true } | { readonly admitted: false; readonly reason: StopReason };

export interface BudgetSnapshot {
  readonly maxTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly unmeteredTrials: number;
  readonly wallMs: number;
}

export interface Budget {
  /** Decide whether one more trial of `flow` may start at wall-clock time `nowMs`. */
  admit(flow: string, nowMs: number): Admission;
  /** Book one finished trial's cost. */
  record(flow: string, cost: TrialCost): void;
  snapshot(nowMs: number): BudgetSnapshot;
}

export const createBudget = (config: BudgetConfig, startedAtMs: number): Budget => {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let unmeteredTrials = 0;
  let unmeteredStop = false;
  const maxSeen = new Map<string, number>();

  return {
    admit(flow, nowMs) {
      if (unmeteredStop) return { admitted: false, reason: 'unmetered' };
      if (config.maxWallMs !== undefined && nowMs - startedAtMs >= config.maxWallMs) {
        return { admitted: false, reason: 'wall' };
      }
      const reserve = maxSeen.get(flow) ?? config.reserveTokens;
      if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens + reserve > config.maxTokens)
        return { admitted: false, reason: 'budget' };
      return { admitted: true };
    },
    record(flow, cost) {
      const trialTokens =
        (cost.inputTokens ?? 0) +
        (cost.outputTokens ?? 0) +
        (cost.cacheReadTokens ?? 0) +
        (cost.cacheCreationTokens ?? 0);
      inputTokens += cost.inputTokens ?? 0;
      outputTokens += cost.outputTokens ?? 0;
      cacheReadTokens += cost.cacheReadTokens ?? 0;
      cacheCreationTokens += cost.cacheCreationTokens ?? 0;
      maxSeen.set(flow, Math.max(maxSeen.get(flow) ?? 0, trialTokens));
      if (cost.metered === false || cost.inputTokens === undefined || cost.outputTokens === undefined) {
        unmeteredTrials += 1;
        if (!config.allowUnmetered) unmeteredStop = true;
      }
    },
    snapshot(nowMs) {
      return {
        maxTokens: config.maxTokens,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        unmeteredTrials,
        wallMs: nowMs - startedAtMs,
      };
    },
  };
};
