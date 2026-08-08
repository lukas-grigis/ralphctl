import { isOpencodeModelIdShape } from '@src/domain/value/settings-models/opencode.ts';
import type { ModelAvailabilityProbe } from '@src/integration/ai/providers/_engine/model-availability-probe.ts';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import { killWithEscalation } from '@src/integration/io/kill-with-escalation.ts';

/** Wall-clock cap for the `opencode models` probe. Beyond this the probe fails open. */
const PROBE_TIMEOUT_MS = 5_000;

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
}

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
 * @public
 */
export const createOpencodeModelAvailabilityProbe = (
  options: OpencodeModelAvailabilityProbeOptions = {}
): ModelAvailabilityProbe => ({
  async availableModels(catalog: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
    const listModels = options.listModels ?? defaultListModels;
    try {
      const models = await listModels(options.command ?? 'opencode', signal);
      // Keep only namespaced, whitespace-free lines so a header or trailing hint printed alongside
      // the list cannot inject junk into the picker. Shares the adapter's own id-shape predicate on
      // purpose: a line this probe admitted but the adapter would refuse to run is an un-runnable
      // picker entry. Multi-segment ids pass — see the note on `isOpencodeModelIdShape`.
      const available = models.filter((line) => isOpencodeModelIdShape(line));
      return available.length > 0 ? available : catalog;
    } catch {
      // Best-effort probe running OUTSIDE the chain runtime — absorb every error including
      // AbortError, exactly as the codex probe does, and fall open to the shipped catalog.
      return catalog;
    }
  },
});

/** Production probe bound to the real `opencode` binary. @public */
export const opencodeModelAvailabilityProbe: ModelAvailabilityProbe = createOpencodeModelAvailabilityProbe();
