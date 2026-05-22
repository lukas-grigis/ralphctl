import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';

/**
 * Test mock for the `HeadlessAiProvider` port. Drives the leaf with controllable `signals.json`
 * content per audit [10]'s nine-branch test grid:
 *
 *   - `ok`          → spawn succeeds; provider writes `signals.json` with the supplied payload.
 *                     `payload` is JSON-stringified; passing `{ schemaVersion, signals }` matches
 *                     the audit-[09] wrapper shape the validator expects.
 *   - `ok-missing`  → spawn succeeds; no file written. Exercises the "signals-missing" path.
 *   - `ok-raw`      → spawn succeeds; file written with the supplied raw bytes (for invalid-JSON
 *                     and schema-mismatch tests).
 *   - `spawn-error` → spawn fails; the supplied DomainError is returned. No file written.
 *   - `abort`       → spawn throws `AbortError`. Used to verify the leaf propagates aborts
 *                     transparently (no swallowing in guards or fallbacks).
 *
 * Fixtures are keyed by **`session.signalsFile`** — the same path the production adapter writes
 * to. Tests construct one fixture per spawn the leaf will perform; an unrecognised path throws
 * loudly so a missing fixture surfaces as a clear test-setup error.
 */
export type SpawnFixture =
  | { readonly kind: 'ok'; readonly payload: unknown; readonly sessionId?: string; readonly exitCode?: number }
  | { readonly kind: 'ok-missing'; readonly sessionId?: string; readonly exitCode?: number }
  | { readonly kind: 'ok-raw'; readonly rawBody: string; readonly sessionId?: string; readonly exitCode?: number }
  | { readonly kind: 'spawn-error'; readonly error: DomainError }
  | { readonly kind: 'abort' };

export interface MockHeadlessProviderRecord {
  readonly signalsFile: AbsolutePath;
  readonly session: AiSession;
}

export interface MockHeadlessProvider {
  readonly provider: HeadlessAiProvider;
  /** Every session the leaf invoked the mock with, in invocation order. */
  readonly invocations: MockHeadlessProviderRecord[];
}

export interface MockHeadlessProviderOpts {
  /**
   * Fixture map keyed by `session.signalsFile` path. Lookup is exact string compare on the
   * absolute path the leaf passes. Use `String(session.signalsFile)` when seeding the map
   * so the brand stripping aligns with the runtime comparison.
   */
  readonly fixtures: ReadonlyMap<string, SpawnFixture>;
  /**
   * Defaults applied to every `ok` fixture's `ProviderOutput` when the fixture itself
   * doesn't specify them. Keeps test fixtures terse — only the fields the test cares about
   * need to appear.
   */
  readonly defaults?: { readonly sessionId?: string; readonly exitCode?: number };
}

const writeSignalsFile = async (path: AbsolutePath, content: string): Promise<Result<void, StorageError>> => {
  try {
    await fs.mkdir(dirname(String(path)), { recursive: true });
    await fs.writeFile(String(path), content, 'utf8');
    return Result.ok(undefined);
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `mock signals-write failed: ${String(path)}`,
        path: String(path),
        cause,
      })
    );
  }
};

export const createMockHeadlessProvider = (opts: MockHeadlessProviderOpts): MockHeadlessProvider => {
  const invocations: MockHeadlessProviderRecord[] = [];
  const provider: HeadlessAiProvider = {
    async generate(session) {
      invocations.push({ signalsFile: session.signalsFile, session });
      const fixture = opts.fixtures.get(String(session.signalsFile));
      if (fixture === undefined) {
        throw new Error(
          `mock-headless-provider: no fixture registered for signalsFile=${String(session.signalsFile)} — register one via opts.fixtures.set(...).`
        );
      }
      if (fixture.kind === 'spawn-error') {
        return Result.error(fixture.error);
      }
      if (fixture.kind === 'abort') {
        throw new AbortError({ elementName: 'mock-headless-provider', reason: 'aborted by fixture' });
      }
      if (fixture.kind === 'ok') {
        const body = JSON.stringify(fixture.payload);
        const wrote = await writeSignalsFile(session.signalsFile, body);
        if (!wrote.ok) return Result.error(wrote.error);
      } else if (fixture.kind === 'ok-raw') {
        const wrote = await writeSignalsFile(session.signalsFile, fixture.rawBody);
        if (!wrote.ok) return Result.error(wrote.error);
      }
      const out: ProviderOutput = {
        signalsFile: session.signalsFile,
        ...(fixture.kind !== 'ok-missing' && fixture.sessionId !== undefined
          ? { sessionId: fixture.sessionId }
          : opts.defaults?.sessionId !== undefined
            ? { sessionId: opts.defaults.sessionId }
            : {}),
        exitCode:
          fixture.kind !== 'ok-missing' && fixture.exitCode !== undefined
            ? fixture.exitCode
            : (opts.defaults?.exitCode ?? 0),
      };
      return Result.ok(out);
    },
  };
  return { provider, invocations };
};
