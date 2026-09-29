import { Result } from '@src/domain/result.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type {
  HeadlessAiProvider,
  ProviderOutput,
  ProviderUsage,
} from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';

/**
 * A scripted `HeadlessAiProvider` that spends no tokens and spawns no AI CLI. It backs `--dry-run`
 * and the harness's own unit tests: each `generate` writes the next scripted response to
 * `session.signalsFile`, mirroring the production file-based contract (the AI writes `signals.json`
 * itself; the provider only reports meta).
 *
 * Responses are consumed in order and the last one repeats, so a test scripts a corrective-nudge
 * sequence as `['missing', [...validSignals]]`.
 */

/** A signal payload without its `timestamp` — the fake stamps one so callers stay terse. */
export type ScriptedSignal = Readonly<Record<string, unknown>> & { readonly type: string };

/**
 * What one scripted spawn does to `signals.json`:
 *  - an array of signals → a valid `{ schemaVersion: 1, signals }` envelope;
 *  - `'missing'` → nothing is written (the model forgot the file);
 *  - `'garbage'` → invalid JSON is written.
 */
export type ScriptedResponse = readonly ScriptedSignal[] | 'missing' | 'garbage';

export interface FakeProviderOptions {
  readonly responses: readonly ScriptedResponse[];
  /** Usage every spawn reports. `null` = report none at all (a provider that omits token counts). */
  readonly usage?: ProviderUsage | null;
  readonly sessionId?: string;
  /** Side effect run before the response is written — e.g. apply a reference patch to the repo. */
  readonly beforeWrite?: (session: AiSession, callIndex: number) => Promise<void>;
}

export interface FakeProvider extends HeadlessAiProvider {
  /** Every session passed to `generate`, in call order. */
  readonly sessions: readonly AiSession[];
}

export const DRY_RUN_USAGE: ProviderUsage = { inputTokens: 1000, outputTokens: 200, durationMs: 1 };

export const createFakeProvider = (opts: FakeProviderOptions): FakeProvider => {
  const sessions: AiSession[] = [];
  return {
    sessions,
    async generate(session) {
      const callIndex = sessions.length;
      sessions.push(session);
      await opts.beforeWrite?.(session, callIndex);
      const response = opts.responses[Math.min(callIndex, opts.responses.length - 1)] ?? 'missing';
      if (response === 'garbage') {
        const wrote = await writeTextAtomic(String(session.signalsFile), '{ not json');
        if (!wrote.ok) return Result.error(wrote.error);
      } else if (response !== 'missing') {
        const stamped = response.map((s) => ({ timestamp: IsoTimestamp.now(), ...s }));
        const wrote = await writeTextAtomic(
          String(session.signalsFile),
          JSON.stringify({ schemaVersion: 1, signals: stamped }, null, 2)
        );
        if (!wrote.ok) return Result.error(wrote.error);
      }
      const usage = opts.usage === undefined ? DRY_RUN_USAGE : opts.usage;
      const output: ProviderOutput = {
        signalsFile: session.signalsFile,
        exitCode: 0,
        sessionId: opts.sessionId ?? 'fake-session',
        ...(usage !== null ? { usage } : {}),
      };
      return Result.ok(output);
    },
  };
};
