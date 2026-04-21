/**
 * AI-assisted project context file and check-script discovery for `project onboard`.
 *
 * Mirrors `discover-check-script.ts` — one headless AI session, strict
 * timeout, best-effort. Failure returns nulls so the pipeline falls through
 * cleanly (the user can still edit manually).
 *
 * Output contract: the AI emits `<agents-md>…</agents-md>` and
 * `<check-script>…</check-script>` (plus `<changes>…</changes>` in update
 * mode). All parsed through the shared signal parser.
 */

import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser.ts';
import { buildRepoOnboardPrompt, type RepoOnboardPromptContext } from '@src/integration/ai/prompts/loader.ts';

export const DISCOVERY_TIMEOUT_MS = 120_000;

export interface AgentsMdDiscoveryResult {
  agentsMd: string | null;
  checkScript: string | null;
  changes: string | null;
}

export async function discoverAgentsMdWithAi(
  ctx: RepoOnboardPromptContext,
  aiSession: AiSessionPort,
  signalParser: SignalParserPort
): Promise<AgentsMdDiscoveryResult> {
  const prompt = buildRepoOnboardPrompt(ctx);

  const session = aiSession.spawnHeadless(prompt, { cwd: ctx.repoPath });
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => {
      resolve(null);
    }, DISCOVERY_TIMEOUT_MS).unref();
  });

  try {
    const result = await Promise.race([session, timeout]);
    if (!result) return { agentsMd: null, checkScript: null, changes: null };
    const signals = signalParser.parseSignals(result.output);
    const agentsSignal = signals.find((s) => s.type === 'agents-md-proposal');
    const checkSignal = signals.find((s) => s.type === 'check-script-discovery');
    const changes = extractChanges(result.output);
    return {
      agentsMd: agentsSignal ? agentsSignal.content : null,
      checkScript: checkSignal ? checkSignal.command : null,
      changes,
    };
  } catch {
    return { agentsMd: null, checkScript: null, changes: null };
  }
}

/**
 * Extract the `<changes>` block from the onboarding AI's output.
 *
 * `<changes>` is intentionally NOT a `HarnessSignal` variant and does not go
 * through `SignalParser`. Rationale: the onboarding session is a one-shot
 * headless call with no dashboard subscriber and no durable handler — the
 * value is consumed inline by this function and handed back through
 * `AgentsMdDiscoveryResult.changes`. Adding a domain type and exhaustiveness
 * updates for a string with a single call site would be over-engineering.
 * If another consumer ever appears, promote it to `SIGNAL_PATTERNS` in
 * `src/integration/signals/parser.ts`.
 */
function extractChanges(output: string): string | null {
  const match = /<changes>([\s\S]*?)<\/changes>/.exec(output);
  if (!match?.[1]) return null;
  const body = match[1].trim();
  return body.length > 0 ? body : null;
}
