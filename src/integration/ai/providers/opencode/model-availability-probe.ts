import { isOpencodeModelIdShape } from '@src/domain/value/settings-models/opencode.ts';
import type {
  ModelAvailabilityProbe,
  ModelProbeDegradationReason,
  ModelProbeDegradationSink,
} from '@src/integration/ai/providers/_engine/model-availability-probe.ts';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import { killWithEscalation } from '@src/integration/io/kill-with-escalation.ts';

/**
 * Wall-clock cap for the `opencode models` probe. Beyond this the probe fails open.
 *
 * Deliberately generous: for the other backends a fail-open costs nothing (their fallback IS the
 * vendor's full list), but here it collapses the picker to the eight zero-auth free-tier ids. A
 * cold `opencode` start that has to reach several upstream providers routinely needs more than a
 * couple of seconds, and the probe runs once per provider per session behind a memoised promise —
 * so waiting is far cheaper than a picker that silently differs between launches.
 */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Run `opencode models` and return its stdout lines. Rejects on spawn failure, non-zero exit, or
 * timeout — every one of those is caught by the caller and turned into a fail-open.
 */
const defaultListModels = (command: string, signal?: AbortSignal): Promise<readonly string[]> =>
  new Promise((resolve, reject) => {
    const child = crossPlatformSpawn(command, ['models'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    // SIGTERM → grace → SIGKILL, not a bare SIGTERM: this promise settles the instant the timeout
    // or abort trips, so a child that ignores SIGTERM would otherwise never be reaped.
    const kill = (): void => {
      killWithEscalation(child);
    };
    const onAbort = (): void => {
      finish(() => {
        kill();
        reject(new Error('opencode models probe aborted'));
      });
    };
    const timer = setTimeout(() => {
      finish(() => {
        kill();
        reject(new Error('opencode models probe timed out'));
      });
    }, PROBE_TIMEOUT_MS);

    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.on('error', (err) => {
      finish(() => {
        reject(err);
      });
    });
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`opencode models exited ${String(code)}`));
          return;
        }
        resolve(
          stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
        );
      });
    });
  });

export interface OpencodeModelAvailabilityProbeOptions {
  /** Test seam: overrides the executable name. Defaults to `opencode`. */
  readonly command?: string;
  /** Test seam: replaces the whole `opencode models` spawn. */
  readonly listModels?: (command: string, signal?: AbortSignal) => Promise<readonly string[]>;
  /**
   * Notified on every fail-open, with the reason. Optional so tests can stay zero-argument; the
   * composition root (`buildModelAvailabilityProbes`) wires it to `Logger.warn`. Must not throw.
   */
  readonly onDegraded?: ModelProbeDegradationSink;
}

/** Best-effort message extraction — the detail is log copy, never control flow. */
const describeCause = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Real OpenCode model-availability probe.
 *
 * OpenCode is an aggregator, so its reachable model set is a property of the operator's
 * authentication state rather than a fixed vendor catalog — `opencode models` is the only
 * authority, and it already answers exactly the question this port asks.
 *
 * This probe therefore differs from its siblings in one deliberate way: it returns the CLI's
 * live list rather than a filtered subset of `catalog`. The shipped catalog is only the
 * zero-auth free tier (see `domain/value/settings-models/opencode.ts`), so intersecting against
 * it would hide every model an authenticated operator actually pays for — the exact opposite of
 * this port's purpose. The `ModelAvailabilityProbe` contract sanctions this for aggregator
 * backends; see the note there.
 *
 * Fails open in the usual way: spawn failure (binary absent), non-zero exit (not authenticated),
 * timeout, abort, or an empty list all resolve to `catalog` unchanged so the picker never blocks
 * or shows zero models.
 *
 * Unlike its siblings, a fail-open here is LOSSY — the shipped catalog is the free tier, not the
 * full list — so every fail-open reports itself through {@link OpencodeModelAvailabilityProbeOptions.onDegraded}
 * with the reason. Without that, an operator whose paid models vanished from the picker had
 * nothing to look at: the same session on the next launch could silently show a different set.
 *
 * Abort is reported, not re-thrown. The `ModelAvailabilityProbe` contract makes this probe
 * best-effort OUTSIDE the chain runtime where the propagate-AbortError rule applies (the codex
 * probe absorbs cancellation the same way), and a cancelled picker must not become a rejected
 * promise. It is no longer silent, which is what the rule is actually protecting against.
 *
 * @public
 */
export const createOpencodeModelAvailabilityProbe = (
  options: OpencodeModelAvailabilityProbeOptions = {}
): ModelAvailabilityProbe => ({
  async availableModels(catalog: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
    const listModels = options.listModels ?? defaultListModels;
    const degraded = (reason: ModelProbeDegradationReason, detail: string): readonly string[] => {
      options.onDegraded?.({ provider: 'opencode', reason, detail });
      return catalog;
    };

    let models: readonly string[];
    try {
      models = await listModels(options.command ?? 'opencode', signal);
    } catch (error) {
      // `signal.aborted` is the only reliable discriminator here — the listing rejects with a
      // plain Error for aborts, timeouts and non-zero exits alike, and the message carries the
      // rest of the story into `detail`.
      return degraded(signal?.aborted === true ? 'probe-aborted' : 'probe-failed', describeCause(error));
    }

    // Keep only namespaced, whitespace-free lines so a header or trailing hint printed alongside
    // the list cannot inject junk into the picker. Shares the adapter's own id-shape predicate on
    // purpose: a line this probe admitted but the adapter would refuse to run is an un-runnable
    // picker entry. Multi-segment ids pass — see the note on `isOpencodeModelIdShape`.
    const available = models.filter((line) => isOpencodeModelIdShape(line));
    if (available.length > 0) return available;
    return degraded('empty-answer', `\`opencode models\` printed ${String(models.length)} line(s), none runnable`);
  },
});
