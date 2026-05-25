import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

/**
 * Generic per-spawn AI session attribution sidecar. Lands at `<outputDir>/meta.json` next to
 * the provider-written `signals.json` / `session-id.txt` so post-mortems, exports, and audit
 * tooling can answer "which provider / model / effort ran this spawn?" without grepping
 * `chain.log` — useful because:
 *
 *   - `chain.log` is debug-grade trace data, not a queryable surface.
 *   - Codex's `session-id.txt` capture is incomplete (the CLI does not always emit one), so
 *     attribution must NOT depend on it.
 *   - Some flows (refine / plan / ideate / readiness / detect-{skills,scripts} / review) write
 *     no audit beyond `signals.json` itself; meta.json gives them the same forensic baseline
 *     as implement's per-round dirs.
 *
 * Pure write leaf: the resolver projects ctx to {@link SessionMetaInput}, the leaf stamps the
 * timestamp from {@link StampSessionMetaDeps.clock}, and the leaf serialises + atomically
 * writes `meta.json`. No ctx mutation.
 *
 * Sequenced BEFORE every AI spawn so attribution survives crashes / signal-missing / spawn
 * failures — if the leaf can write its 2 kB JSON sidecar it has nothing to lose by writing
 * first.
 */

/**
 * Per-spawn metadata projected into `meta.json`. Required fields identify the provider and
 * model unambiguously; optional fields pin the spawn into the surrounding chain (task / round
 * / attempt / ticket / escalation).
 *
 * Fields are deliberately flat strings — JSON consumers should be tooling-friendly without
 * needing a domain-aware reader.
 */
export interface SessionMetaInput {
  /** Per-spawn output directory — meta.json lands at `<outputDir>/meta.json`. */
  readonly outputDir: AbsolutePath;
  /**
   * Flow identifier — discriminates spawns from the same flow that play different roles
   * (e.g. `implement-generator` vs `implement-evaluator`). Free-form string; no enum is
   * enforced at the type level so new flow / role pairs are additive.
   */
  readonly flow: string;
  /** Resolved provider id (e.g. `claude-code` / `github-copilot` / `openai-codex`). */
  readonly provider: string;
  /** Resolved model id (provider catalog entry or operator-supplied custom string). */
  readonly model: string;
  /** Resolved effort / reasoning level after provider flooring. `null` when unset. */
  readonly effort: string | null;
  /** Attempt index within the task — 1-based. Only set by implement-style flows. */
  readonly attemptN?: number;
  /** Round index within the attempt — 1-based. Only set by gen-eval iterations. */
  readonly roundN?: number;
  /** Source ticket id, when the spawn is per-ticket (refine). */
  readonly ticketId?: string;
  /** Source task id, when the spawn is per-task (implement, review). */
  readonly taskId?: string;
  /**
   * Generator model the task escalated AWAY from on this attempt, if any. Captured here
   * because `meta.json` is the per-spawn record — post-mortems can match "this attempt was on
   * the escalated rung" without joining against `tasks.json`.
   */
  readonly escalatedFromModel?: string | null;
}

/**
 * On-disk shape of `meta.json`. Includes the ISO timestamp the leaf stamps from
 * {@link StampSessionMetaDeps.clock} so consumers don't need to join against the chain trace
 * to know when the spawn started.
 */
interface SessionMeta {
  readonly flow: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string | null;
  readonly startedAt: IsoTimestamp;
  readonly attemptN?: number;
  readonly roundN?: number;
  readonly ticketId?: string;
  readonly taskId?: string;
  readonly escalatedFromModel?: string | null;
}

export interface StampSessionMetaDeps {
  /** Atomic file writer — production wires the tmp+rename adapter. */
  readonly writeFile: WriteFile;
  /**
   * ISO timestamp source — stamped into `startedAt`. Injected (not `new Date()`) so tests
   * can pin the timestamp and the leaf stays pure.
   */
  readonly clock: () => IsoTimestamp;
}

export interface StampSessionMetaOpts<TCtx> {
  /** Step name surfaced in the trace (e.g. `stamp-session-meta-refine-<ticket-id>`). */
  readonly name: string;
  /**
   * Project ctx → {@link SessionMetaInput}. Throws `DomainError` for ctx-shape violations;
   * any other throw is a programmer bug and re-propagates.
   */
  readonly resolve: (ctx: TCtx) => SessionMetaInput;
}

/**
 * Build the JSON body. Optional fields are emitted only when present so consumers can tell
 * "no round number" from "round 0".
 */
const renderMeta = (input: SessionMetaInput, startedAt: IsoTimestamp): string => {
  const body: SessionMeta = {
    flow: input.flow,
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    startedAt,
    ...(input.attemptN !== undefined ? { attemptN: input.attemptN } : {}),
    ...(input.roundN !== undefined ? { roundN: input.roundN } : {}),
    ...(input.ticketId !== undefined ? { ticketId: input.ticketId } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.escalatedFromModel !== undefined ? { escalatedFromModel: input.escalatedFromModel } : {}),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
};

export const stampSessionMetaLeaf = <TCtx>(
  deps: StampSessionMetaDeps,
  opts: StampSessionMetaOpts<TCtx>
): Element<TCtx> =>
  leaf<TCtx, SessionMetaInput, void>(opts.name, {
    useCase: {
      execute: async (input) => {
        const startedAt = deps.clock();
        const targetPath = AbsolutePath.parse(join(String(input.outputDir), 'meta.json'));
        if (!targetPath.ok) return Result.error(targetPath.error as DomainError);
        const wrote = await deps.writeFile(targetPath.value, renderMeta(input, startedAt));
        if (!wrote.ok) return Result.error(wrote.error);
        return Result.ok(undefined);
      },
    },
    input: (ctx) => opts.resolve(ctx),
    // Pure write — leaf does not mutate ctx.
    output: (ctx) => ctx,
  });
