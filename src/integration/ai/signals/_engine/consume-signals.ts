import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import { readSignalsFile } from '@src/integration/ai/signals/_engine/read-signals-file.ts';

/**
 * One-call boilerplate every flow that consumes a `HeadlessAiProvider` performs:
 *
 *   1. `provider.generate(session)` — runs the AI; writes parsed signals to `session.signalsFile`.
 *   2. Read the file back into `HarnessSignal[]`.
 *   3. Forward every signal to the harness sink (TUI / progress.md / etc.).
 *   4. Return the array to the caller so it can pick its own signal types out.
 *
 * Six leaves had this exact shape inlined before. Collapsing it here keeps the file-based
 * contract uniform — the next caller can't forget to fan out to the sink, and the file-read
 * error path is centralised. `sessionId` / `exitCode` are intentionally discarded here; callers
 * that need them call `provider.generate` directly.
 */
export const consumeSignals = async (
  provider: HeadlessAiProvider,
  session: AiSession,
  sink: HarnessSignalSink
): Promise<Result<readonly HarnessSignal[], DomainError>> => {
  const out = await provider.generate(session);
  if (!out.ok) return Result.error(out.error);
  const loaded = await readSignalsFile(out.value.signalsFile);
  if (!loaded.ok) return Result.error(loaded.error);
  for (const sig of loaded.value) sink.emit(sig);
  return Result.ok(loaded.value);
};
