/**
 * AI-assisted check-script discovery.
 *
 * Used by `project add` / `project repo add` ONLY when static ecosystem
 * detection (`suggestCheckScript`) returns null — i.e., the project is
 * polyglot, custom, or uses an uncommon build tool. The AI session is
 * read-only by prompt contract; the harness never executes the suggested
 * command, only surfaces it as an editable default for the user to approve.
 *
 * The output contract is a single `<check-script>…</check-script>` element,
 * parsed via the shared `SignalParserPort` so the discovery output flows
 * through the same `HarnessSignal` pipeline as task-execution signals — no
 * bespoke regex, no parallel parser. If we ever need richer structured
 * output, introduce a dedicated `OutputParserPort` adapter (the way
 * tasks.json works) rather than special-casing here.
 */

import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser.ts';
import { buildCheckScriptDiscoverPrompt } from '@src/integration/ai/prompts/loader.ts';

export const DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Ask the configured AI provider to inspect `repoPath` and propose a check
 * script. Hard-bounded at {@link DISCOVERY_TIMEOUT_MS} ms — on timeout, any
 * spawn failure, or unparseable output, returns `null` so the caller falls
 * through to the manual-input path. We never surface a user-facing error
 * here: the discovery is best-effort, the user always retains the manual
 * fallback.
 *
 * Read-only enforcement is by prompt contract — neither Claude nor Copilot
 * exposes a CLI flag that durably forbids writes (Claude's
 * `--permission-mode acceptEdits` is the opposite of what we want, and
 * Copilot's `--allow-all-tools` only relaxes prompts). The prompt itself
 * tells the agent "do not modify the working tree".
 */
export async function discoverCheckScriptWithAi(
  repoPath: string,
  aiSession: AiSessionPort,
  signalParser: SignalParserPort
): Promise<string | null> {
  const prompt = buildCheckScriptDiscoverPrompt(repoPath);

  const session = aiSession.spawnHeadless(prompt, { cwd: repoPath });
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => {
      resolve(null);
    }, DISCOVERY_TIMEOUT_MS).unref();
  });

  try {
    const result = await Promise.race([session, timeout]);
    if (!result) return null; // timeout
    const signals = signalParser.parseSignals(result.output);
    const discovery = signals.find((s) => s.type === 'check-script-discovery');
    return discovery ? discovery.command : null;
  } catch {
    // Best-effort: discovery is optional, never blocks the flow.
    return null;
  }
}
