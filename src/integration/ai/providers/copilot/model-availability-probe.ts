import type {
  ModelAvailabilityProbe,
  ModelProbeDegradationReason,
  ModelProbeDegradationSink,
} from '@src/integration/ai/providers/_engine/model-availability-probe.ts';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import { killWithEscalation } from '@src/integration/io/kill-with-escalation.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';

/** Wall-clock cap for the whole probe; a cold `copilot --headless` answers in ~4s. */
const PROBE_TIMEOUT_MS = 15_000;

/** One `models.list` entry — only the fields the probe reads. */
export interface CopilotListedModel {
  readonly id: string;
  /** `enabled` / `disabled` / `unconfigured`; absent on models with no account policy. */
  readonly policyState?: string;
}

const encodeFrame = (id: number, method: string): string => {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: {} });
  return `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`;
};

const toListedModel = (entry: unknown): CopilotListedModel | undefined => {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { id, policy } = entry as { id?: unknown; policy?: unknown };
  if (typeof id !== 'string') return undefined;
  const state = typeof policy === 'object' && policy !== null ? (policy as { state?: unknown }).state : undefined;
  return typeof state === 'string' ? { id, policyState: state } : { id };
};

type RpcMessage = { readonly id?: unknown; readonly result?: unknown; readonly error?: unknown };

/** Stateful `Content-Length` frame splitter for the CLI's stdout; stops at the first bad frame. */
const createFrameReader = (
  onMessage: (message: RpcMessage) => void,
  onError: (error: Error) => void
): ((chunk: Buffer) => void) => {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const length = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('utf8'))?.[1];
      if (length === undefined) {
        onError(new Error('copilot models probe: frame without Content-Length'));
        return;
      }
      const end = headerEnd + 4 + Number(length);
      if (buffer.length < end) return;
      const raw = buffer.subarray(headerEnd + 4, end).toString('utf8');
      buffer = buffer.subarray(end);
      try {
        onMessage(JSON.parse(raw) as RpcMessage);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  };
};

/**
 * Ask the Copilot CLI for the account's models through its own headless JSON-RPC server
 * (`copilot --headless --stdio`, the transport the official Copilot SDK uses): `connect`, then
 * `models.list`. The CLI does the auth, so no keychain token or token exchange is involved.
 * Rejects on spawn failure, early exit, an RPC error, or timeout — the caller fails open.
 */
const defaultListModels = (command: string, signal?: AbortSignal): Promise<readonly CopilotListedModel[]> =>
  new Promise((resolve, reject) => {
    const child = crossPlatformSpawn(command, ['--headless', '--no-auto-update', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      killWithEscalation(child);
      fn();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(new Error('copilot models probe aborted'));
      });
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error('copilot models probe timed out'));
      });
    }, PROBE_TIMEOUT_MS);

    const onMessage = (message: RpcMessage): void => {
      if (message.error !== undefined) {
        finish(() => {
          reject(new Error(`copilot models probe: ${JSON.stringify(message.error)}`));
        });
        return;
      }
      // id 1 = `connect` handshake, id 2 = `models.list`; server-initiated messages carry no match.
      if (message.id === 1) child.stdin?.write(encodeFrame(2, 'models.list'));
      if (message.id !== 2) return;
      const models = (message.result as { models?: unknown } | undefined)?.models;
      finish(() => {
        if (!Array.isArray(models)) reject(new Error('copilot models probe: no models array'));
        else resolve(models.map(toListedModel).filter((m): m is CopilotListedModel => m !== undefined));
      });
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on(
      'data',
      createFrameReader(onMessage, (error) => {
        finish(() => {
          reject(error);
        });
      })
    );
    child.stdin?.on('error', () => {
      // EPIPE when the CLI exits early — the 'close' handler reports it.
    });
    child.on('error', (err) => {
      finish(() => {
        reject(err);
      });
    });
    child.on('close', (code) => {
      finish(() => {
        reject(new Error(`copilot exited ${String(code)} before listing models`));
      });
    });
    child.stdin?.write(encodeFrame(1, 'connect'));
  });

export interface CopilotModelAvailabilityProbeOptions {
  /** Test seam: overrides the executable name. Defaults to `copilot`. */
  readonly command?: string;
  /** Test seam: replaces the whole headless-server exchange. */
  readonly listModels?: (command: string, signal?: AbortSignal) => Promise<readonly CopilotListedModel[]>;
  /** Notified on every fail-open, with the reason. Must not throw. */
  readonly onDegraded?: ModelProbeDegradationSink;
}

/**
 * Real Copilot model-availability probe: the catalog narrowed to the models the signed-in account
 * can run. A model counts as available when `models.list` returns it with an `enabled` policy, or
 * with no policy at all (models without an account toggle). Fails open to `catalog` on spawn
 * failure (CLI missing or signed out), timeout, abort, protocol drift, or an empty intersection.
 *
 * The `connect` handshake is marked experimental in the Copilot SDK, so protocol drift is the
 * expected failure mode — fail-open keeps that harmless.
 *
 * @public
 */
export const createCopilotModelAvailabilityProbe = (
  options: CopilotModelAvailabilityProbeOptions = {}
): ModelAvailabilityProbe => ({
  async availableModels(catalog: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
    const listModels = options.listModels ?? defaultListModels;
    const degraded = (reason: ModelProbeDegradationReason, detail: string): readonly string[] => {
      options.onDegraded?.({ provider: 'github-copilot', reason, detail });
      return catalog;
    };

    let listed: readonly CopilotListedModel[];
    try {
      listed = await listModels(options.command ?? 'copilot', signal);
    } catch (error) {
      return degraded(signal?.aborted === true ? 'probe-aborted' : 'probe-failed', messageOf(error));
    }
    const usable = new Set(
      listed.filter((m) => m.policyState === undefined || m.policyState === 'enabled').map((m) => m.id)
    );
    const available = catalog.filter((model) => usable.has(model));
    if (available.length > 0) return available;
    return degraded('empty-answer', `models.list returned ${String(listed.length)} model(s), none in the catalog`);
  },
});
