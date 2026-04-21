/**
 * Shared check-script collection helper for the Ink `project add` and
 * `project repo add` flows. Mirrors the plain-text CLI's
 * `addCheckScriptToRepository`: static detection → AI fallback (when
 * enabled + provider configured) → editable manual input. Returns
 * `undefined` when the user leaves the field blank, matching the CLI's
 * `checkScript || undefined` behaviour.
 *
 * `setStep` lets the caller drive the spinner label between prompts so
 * the user sees what is happening at each substep.
 */

import { getPrompt } from '@src/integration/bootstrap.ts';
import { detectCheckScriptCandidates, suggestCheckScript } from '@src/integration/external/detect-scripts.ts';
import { discoverCheckScriptWithAi } from '@src/integration/ai/discover-check-script.ts';
import { getConfig } from '@src/integration/persistence/config.ts';
import { getConfigDefaultValue } from '@src/integration/config/schema-provider.ts';
import { ProviderAiSessionAdapter } from '@src/integration/ai/session/session-adapter.ts';
import { SignalParser } from '@src/integration/signals/parser.ts';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';

export async function collectCheckScript(
  repoPath: string,
  setStep: (step: 'check-script' | 'discovering') => void
): Promise<string | undefined> {
  const prompt = getPrompt();

  setStep('check-script');
  // Plain-text CLI wraps this in Result.try; mirror that robustness here so
  // a throwing fs read (permissions, race) falls through to the AI/manual
  // path instead of blowing up the whole view.
  let detection: ReturnType<typeof detectCheckScriptCandidates>;
  try {
    detection = detectCheckScriptCandidates(repoPath);
  } catch {
    detection = null;
  }
  let suggested: string | null = detection ? suggestCheckScript(repoPath) : null;

  if (suggested === null) {
    const config = await getConfig();
    const enabled = config.aiCheckScriptDiscovery ?? (getConfigDefaultValue('aiCheckScriptDiscovery') as boolean);
    if (enabled && config.aiProvider) {
      const wantAi = await prompt.confirm({
        message: 'No ecosystem detected. Ask AI to inspect the repo and suggest a check script?',
        default: true,
      });
      if (wantAi) {
        setStep('discovering');
        const aiSession = new ProviderAiSessionAdapter();
        const signalParser = new SignalParser();
        const discoverR = await wrapAsync(async () => {
          await aiSession.ensureReady();
          return discoverCheckScriptWithAi(repoPath, aiSession, signalParser);
        }, ensureError);
        if (discoverR.ok && discoverR.value) {
          suggested = discoverR.value;
        }
        setStep('check-script');
      }
    }
  }

  const value = await prompt.input({
    message: 'Check script (optional):',
    default: suggested ?? undefined,
  });
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
