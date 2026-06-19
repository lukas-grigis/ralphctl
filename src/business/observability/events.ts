import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AiSignal } from '@src/domain/signal.ts';

/**
 * Application-wide structured events. Producers (chain runner, use cases,
 * adapters) publish these via {@link EventBus}; subscribers (TUI panels,
 * progress files, future webhooks) read them without knowing who fired them.
 *
 * Each variant is a named interface so subscribers can take the variant
 * directly (`(e: LogEvent) => void`) instead of narrowing the whole union.
 * The discriminated `type` field is the only field guaranteed across variants;
 * each variant carries its own correlation handles (`chainId`, `taskId`,
 * `sprintId`, …) so a subscriber can filter by topic without parsing strings.
 *
 * `LogEvent` is included so the existing log-emit producers fold into the bus —
 * one subscriber taps both progress milestones and free-form messages without
 * two ports.
 */

export interface ChainStartedEvent {
  readonly type: 'chain-started';
  readonly chainId: string;
  readonly flowId: string;
  readonly at: IsoTimestamp;
}

export interface ChainStepStartedEvent {
  readonly type: 'chain-step-started';
  readonly chainId: string;
  readonly elementName: string;
  readonly at: IsoTimestamp;
}

export interface ChainStepCompletedEvent {
  readonly type: 'chain-step-completed';
  readonly chainId: string;
  readonly elementName: string;
  readonly durationMs: number;
  readonly at: IsoTimestamp;
}

export interface ChainStepFailedEvent {
  readonly type: 'chain-step-failed';
  readonly chainId: string;
  readonly elementName: string;
  readonly error: DomainError;
  readonly durationMs: number;
  readonly at: IsoTimestamp;
}

export interface ChainCompletedEvent {
  readonly type: 'chain-completed';
  readonly chainId: string;
  readonly at: IsoTimestamp;
}

export interface ChainFailedEvent {
  readonly type: 'chain-failed';
  readonly chainId: string;
  readonly error: DomainError;
  readonly at: IsoTimestamp;
}

export interface ChainAbortedEvent {
  readonly type: 'chain-aborted';
  readonly chainId: string;
  readonly reason?: string;
  readonly at: IsoTimestamp;
}

export interface TaskAttemptStartedEvent {
  readonly type: 'task-attempt-started';
  readonly taskId: string;
  readonly sessionId: string;
  readonly at: IsoTimestamp;
}

export interface TaskAttemptEvaluatedEvent {
  readonly type: 'task-attempt-evaluated';
  readonly taskId: string;
  readonly verdict: 'passed' | 'failed' | 'malformed';
  readonly at: IsoTimestamp;
}

/**
 * Fired once at the start of every gen-eval round for the in-flight task — the discrete
 * boundary the chain trace lacks (back-to-back `generator-<id>` / `evaluator-<id>` entries
 * carry no round number). Replaces the TUI's ref-based round-counter high-water mark with an
 * authoritative source: the latest event's `roundN` is the round currently running.
 *
 *  - `roundN` is 1-indexed and matches the on-disk `rounds/<N>/` folder index used by the
 *    generator + evaluator leaves.
 *  - `totalCap` is the configured `settings.harness.maxTurns`, surfaced so subscribers can
 *    render `round N/M` without a second config lookup.
 *  - `attemptN` is the 1-indexed attempt-within-task counter — multiple attempts are gated by
 *    `task.maxAttempts`; emitted here so the recent-log tail can disambiguate "round 2 of
 *    attempt 1" vs. "round 1 of attempt 2".
 */
export interface TaskRoundStartedEvent {
  readonly type: 'task-round-started';
  readonly taskId: string;
  readonly attemptN: number;
  readonly roundN: number;
  readonly totalCap: number;
  readonly at: IsoTimestamp;
}

export interface FeedbackRoundAppliedEvent {
  readonly type: 'feedback-round-applied';
  readonly sprintId: string;
  readonly round: number;
  readonly at: IsoTimestamp;
}

export interface LogEvent {
  readonly type: 'log';
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly at: IsoTimestamp;
}

/**
 * Process-wide heap-pressure signal. Emitted by the heap watchdog on every
 * threshold TRANSITION (not on every poll) so subscribers can render a banner
 * that mirrors the current band without de-duping a stream of identical samples.
 *
 * `'recovered'` is fired once when the ratio drops back below the warning band,
 * giving the banner an explicit clear signal.
 */
export interface MemoryPressureEvent {
  readonly type: 'memory-pressure';
  readonly severity: 'warning' | 'critical' | 'recovered';
  /** heapUsed / heap_size_limit ratio at sample time, 0–1. */
  readonly ratio: number;
  /** Bytes used. */
  readonly heapUsed: number;
  /** V8's `heap_size_limit`. */
  readonly heapLimit: number;
  readonly at: IsoTimestamp;
}

/**
 * Signals that the persistent `<sprintDir>/chain.log` sink can no longer keep up with the
 * event-bus firehose — either because its in-memory queue hit the back-pressure cap
 * (`reason: 'queue-full'`) or because an actual `fs.appendFile` write rejected
 * (`reason: 'write-failed'`). Emitted EXACTLY ONCE per sink lifetime: once the first
 * degradation fires the sink stops re-emitting, because the contract is "tell the operator
 * the log is no longer trustworthy", not "spam the bus every time a write fails". The TUI
 * latches a banner from this event and only clears it when the TUI restarts.
 */
export interface ChainLogDegradedEvent {
  readonly type: 'chain-log-degraded';
  readonly reason: 'queue-full' | 'write-failed';
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly at: IsoTimestamp;
}

/**
 * Final token-usage figure for one provider spawn, emitted ONCE per spawn after the AI session
 * finishes cleanly (non-zero exit / abort → no event). Lets the TUI show a budget widget,
 * lets future telemetry sinks pipe spend to a backend, etc.
 *
 * Every numeric field is optional because what each provider reports varies — Claude's
 * stream-json `result` event carries full `usage{ input_tokens, output_tokens, cache_* }`;
 * Copilot's JSON meta line may or may not include any counter; Codex's JSONL config record
 * historically carries none. The event is still emitted in the lean case (sessionId + provider
 * + maybe model) so subscribers can correlate per-spawn telemetry without inferring
 * "did the spawn succeed?" from the absence of a token field.
 *
 *  - `contextWindow` is the model's total budget — looked up from a static table in the
 *    `_engine/context-window.ts` adapter when the provider reports a known model; omitted
 *    otherwise. The TUI widget renders `(input + output) / contextWindow` when both are known.
 */
export interface TokenUsageEvent {
  readonly type: 'token-usage';
  /**
   * The AI CLI's own session uuid for this spawn (Claude `system.init` id, Copilot `sessionId`,
   * Codex `thread_id`). Stable per provider spawn — useful for forensic correlation against the
   * persisted `session-id.txt` sidecar — but it lives in a DIFFERENT id space from the chain
   * runner id the TUI keys its views on. Subscribers that need the runner id read
   * {@link chainSessionId} instead.
   */
  readonly sessionId: string;
  /**
   * The chain runner / session id this spawn ran under, read from `currentSessionId()` (the
   * runner wraps every `element.execute()` in `runWithSession(id, …)`). This is the id the TUI
   * execute view looks up by, so subscribers that drive per-runner widgets (the TokenBudgetCard)
   * MUST key on `chainSessionId ?? sessionId` — the provider-uuid `sessionId` never matches a
   * runner id. Optional because one-shot spawns outside any chain scope (and legacy events) have
   * no runner id; those still resolve by the provider-uuid `sessionId`.
   */
  readonly chainSessionId?: string;
  readonly provider: 'claude-code' | 'github-copilot' | 'openai-codex';
  readonly model?: string;
  /**
   * CUMULATIVE token counts for the whole spawn — these are throughput / billing figures. For
   * Claude `-p` they sum across every internal turn of the spawn, so `cacheReadTokens` can dwarf
   * the context window after many turns. Do NOT compute context-window occupancy from these.
   */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  /**
   * LIVE per-turn token counts — a single-call snapshot from the LAST assistant turn of the spawn.
   * `liveInputTokens + liveCacheReadTokens + liveCacheCreationTokens` is the true current
   * context-window occupancy, correct regardless of how the cumulative figures above aggregate.
   * Claude `-p` only; absent for copilot/codex (which don't stream per-turn usage) and for spawns
   * where no assistant event carried usage. Subscribers render the context bar from these.
   */
  readonly liveInputTokens?: number;
  readonly liveCacheReadTokens?: number;
  readonly liveCacheCreationTokens?: number;
  readonly contextWindow?: number;
  /**
   * Implement-flow gen-eval role the spawn ran under. Stamped on the event by the provider
   * adapter when the {@link AiSession} carries a `role`; absent for single-role flows
   * (refine / plan / readiness / ideate / review) and for one-shot inventory roundtrips
   * (detect-scripts / detect-skills). Lets per-session subscribers attribute token spend to
   * one half of the cross-provider implement pair without inferring from `provider` alone.
   */
  readonly role?: 'generator' | 'evaluator';
  readonly at: IsoTimestamp;
}

/**
 * Tiered status banner — generic surface for "operator should know this is happening" signals
 * that don't deserve their own bespoke banner component. Emitters publish a `banner-show`
 * keyed by a stable `id` (e.g. `'rate-limit-<sessionId>'`, `'lock-<sprintId>'`); a matching
 * `banner-clear` removes it. Re-publishing the same id replaces (not stacks) the prior banner,
 * so emitters can refresh the visible state without bookkeeping a dedicated clear-then-show.
 *
 * Three tiers, ordered most-urgent-first:
 *
 *  - `error` — user action required (setup script failed, provider crash).
 *  - `warn`  — operator should notice but harness can keep going (watchdog kill, lock
 *               contention, baseline-broken).
 *  - `info`  — transient state worth surfacing (rate-limit backoff, provider reconnect).
 *
 * The TUI's `StatusBanner` subscribes; emitters never reference the component directly.
 */
export interface BannerShowEvent {
  readonly type: 'banner-show';
  /** Stable key — re-publishing replaces; clears match on id. */
  readonly id: string;
  readonly tier: 'info' | 'warn' | 'error';
  readonly message: string;
  /** Optional supplementary detail rendered dim beside the message. */
  readonly cause?: string;
  readonly at: IsoTimestamp;
}

export interface BannerClearEvent {
  readonly type: 'banner-clear';
  readonly id: string;
  readonly at: IsoTimestamp;
}

/**
 * Discriminated union of the two banner events — exported as a type alias so emitters can
 * type-narrow a single subscription handler over both variants without restating the union.
 * @public
 */
export type BannerEvent = BannerShowEvent | BannerClearEvent;

/**
 * Per-task harness signal — published when the AI emits a `<change>`, `<learning>`, or
 * `<note>` tag during an in-flight task. The harness mirrors the validated `HarnessSignal`
 * onto the {@link EventBus} so the TUI's per-task panel + the persistent `<sprintDir>/chain.log`
 * retain a machine-readable record of the per-task narrative.
 *
 * Decisions stay on their own dedicated event (see {@link AiSignalEvent}) — they're surfaced
 * to the operator with extra emphasis (`progress.md` Decisions section) so flattening them
 * into this stream would lose that affordance.
 */
export interface HarnessSignalEvent {
  readonly type: 'harness-signal';
  readonly signalKind: 'change' | 'learning' | 'note';
  /**
   * Task the signal was emitted under. Absent when the harness cannot attribute the
   * signal — e.g. signals emitted during a non-task subchain. Renderers that group by
   * task simply skip unattributed entries.
   */
  readonly taskId?: string;
  readonly text: string;
  readonly at: IsoTimestamp;
}

/**
 * Validated `AiSignal` published by an AI-spawning leaf AFTER the spawn's `signals.json`
 * was parsed by `validateSignalsFile` under the audit-[09] contract. Subscribers (TUI,
 * persistent `chain.log`, future progress.md miners) receive the typed signal verbatim
 * along with the originating leaf's short name in `source` so a multi-leaf flow's events
 * stay attributable.
 *
 * Distinct from {@link HarnessSignalEvent}: that one is a derived per-task slice carrying
 * only the three text-bearing kinds; this one carries every validated signal kind the
 * leaf accepted. Both coexist while the migration is in flight — `HarnessSignalEvent` is
 * still produced by the legacy stdout-parser path and consumed by the per-task chain-log
 * miner; `AiSignalEvent` is produced by the new file-contract leaves.
 */
export interface AiSignalEvent {
  readonly type: 'ai-signal';
  readonly signal: AiSignal;
  /** Short name of the AI-spawning leaf that produced the signal (e.g. `'generator'`). */
  readonly source: string;
}

/**
 * Once-per-task generator model escalation fired. Published by the escalation policy in
 * `finalize-gen-eval` immediately after the task entity is stamped with
 * `escalatedFromModel` / `escalatedToModel` — i.e. before the attempt settles — so subscribers
 * (TUI banner, persistent `chain.log`) see the upgrade decision in chronological order with
 * the surrounding settle / round trace.
 *
 *  - `taskId`    — the in-flight task whose generator model just escalated.
 *  - `attemptN`  — 1-indexed `task.attempts.length` at decision time, i.e. the attempt that
 *                  just plateaued. The next attempt (`attemptN + 1`) is the one that spawns
 *                  with the upgraded model.
 *  - `from` / `to` — model ids the policy moved between. Always non-empty.
 *  - `reason`    — the gen-eval exit kind that triggered the escalation. `'plateau'` (two
 *                  consecutive failed evals on the same dimensions) and `'budget-exhausted'`
 *                  (the turn budget ran out without a terminal verdict) both drive the model
 *                  ladder. `'plateau'` is kept as a member so any consumer that matched the
 *                  prior single-literal shape still narrows. `'malformed'` is deliberately
 *                  absent — that exit is the evaluator's failure and never escalates the model.
 */
export interface ModelEscalatedEvent {
  readonly type: 'model-escalated';
  readonly taskId: string;
  readonly attemptN: number;
  readonly from: string;
  readonly to: string;
  readonly reason: 'plateau' | 'budget-exhausted';
  readonly at: IsoTimestamp;
}

export type AppEvent =
  | ChainStartedEvent
  | ChainStepStartedEvent
  | ChainStepCompletedEvent
  | ChainStepFailedEvent
  | ChainCompletedEvent
  | ChainFailedEvent
  | ChainAbortedEvent
  | TaskAttemptStartedEvent
  | TaskAttemptEvaluatedEvent
  | TaskRoundStartedEvent
  | FeedbackRoundAppliedEvent
  | LogEvent
  | MemoryPressureEvent
  | ChainLogDegradedEvent
  | TokenUsageEvent
  | BannerShowEvent
  | BannerClearEvent
  | HarnessSignalEvent
  | AiSignalEvent
  | ModelEscalatedEvent;
