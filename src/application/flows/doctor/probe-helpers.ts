/**
 * Small shared builders used by both `probe-groups.ts` and `provider-auth.ts`. Pulled out of
 * `probe-groups.ts` so neither module has to import the other — `probe-groups.ts` calls
 * `probeProviderAuth` from `provider-auth.ts`, and `provider-auth.ts` needs the same
 * `mkProbe` / `PROVIDER_LABEL` building blocks; putting them here avoids a two-file cycle.
 */

import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { ProbeGroup, ProbeResult } from '@src/application/flows/doctor/ctx.ts';

export const PROVIDER_LABEL: Readonly<Record<AiProvider, string>> = {
  'claude-code': 'Claude Code',
  'github-copilot': 'GitHub Copilot',
  'openai-codex': 'OpenAI Codex',
  opencode: 'OpenCode',
};

/** Build a {@link ProbeResult} — `hint` is included only when supplied. */
export const mkProbe = (
  id: string,
  label: string,
  status: ProbeResult['status'],
  detail: string,
  group: ProbeGroup,
  hint?: string
): ProbeResult => ({ id, label, status, detail, group, ...(hint !== undefined ? { hint } : {}) });
