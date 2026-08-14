/**
 * Per-provider "is this CLI authenticated?" probe. Each {@link AiProvider} answers this
 * question through a different local, cheap mechanism — parsed local CLI output only, never a
 * network round-trip and never a `--live` flag. A future contributor tempted to add one should
 * read this header first: doctor's promise is "what can be answered from the local machine
 * right now", not "prove the CLI can reach its provider".
 *
 * Verified live against each installed CLI (read-only, no tokens spent):
 *  - claude  → `claude auth status` prints JSON `{"loggedIn":true,"authMethod":…}`, exit 0
 *    regardless of login state — the JSON field is the signal, not the exit code. Only
 *    `loggedIn` and `authMethod` are ever read; email / subscription fields are ignored so they
 *    can never leak into a probe detail a user might paste into a bug report.
 *  - codex   → `codex login status` exits 0 when logged in ("Logged in using ChatGPT"). The
 *    logged-out exit code has NOT been verified live on this machine (only the logged-in path
 *    was available to probe) — the existing exit-code semantics are kept as-is; treat this as a
 *    documented gap for a manual smoke check before shipping, not a live bug.
 *  - opencode → `opencode providers list` (alias `opencode auth list`) exits 0 and prints an
 *    "N credentials" tail even when N is 0 — OpenCode's free tier needs no credentials, so
 *    neither the exit code nor an empty count proves anything either way. N >= 1 is the only
 *    state we can call `pass`; N == 0 and anything unparseable report `unknown`, never `warn`.
 *  - copilot → the CLI exposes no non-interactive auth-status subcommand at all
 *    (`completion/help/init/login/mcp/plugin/plugins/skill/update/version`). The probe reports
 *    `unknown` WITHOUT spawning anything.
 *
 * Rules, enforced uniformly here rather than per-branch:
 *  - This probe never returns `'fail'` — worst case is `'warn'` (a CLI that answered "not
 *    authenticated"). Doctor's exit code is driven by `hasFailures`, and "you haven't signed in
 *    yet" shouldn't fail a CI health check the way a missing binary does.
 *  - A non-zero exit whose stderr reads like an unrecognised subcommand (older CLI build)
 *    degrades to `'unknown'`, not `'warn'` — we didn't learn "not authenticated", we learned
 *    "this CLI version doesn't support the verb we tried".
 *  - Unparseable output (bad JSON, no "N credentials" tail) is `'unknown'`, never guessed at.
 *  - ANSI escape codes are stripped before parsing — `opencode` decorates its CLI output.
 */

import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { RunCommand } from '@src/integration/io/run-command.ts';
import { PROVIDER_BINARY } from '@src/integration/system/detect-cli.ts';
import type { ProbeResult } from '@src/application/flows/doctor/ctx.ts';
import { mkProbe, PROVIDER_LABEL } from '@src/application/flows/doctor/probe-helpers.ts';

interface JsonFieldAuthCheck {
  readonly kind: 'json-field';
  readonly args: readonly string[];
  /** Boolean JSON field on stdout that determines pass/warn. */
  readonly field: string;
  readonly hint: string;
}

interface ExitCodeAuthCheck {
  readonly kind: 'exit-code';
  readonly args: readonly string[];
  readonly hint: string;
}

interface CredentialCountAuthCheck {
  readonly kind: 'credential-count';
  readonly args: readonly string[];
}

interface NoneAuthCheck {
  readonly kind: 'none';
  /** Why this provider can't be probed — surfaced verbatim as the probe detail. */
  readonly reason: string;
}

export type ProviderAuthCheck = JsonFieldAuthCheck | ExitCodeAuthCheck | CredentialCountAuthCheck | NoneAuthCheck;

/** One entry per {@link AiProvider} — see the module header for the mechanism each relies on. */
export const PROVIDER_AUTH_CHECK: Readonly<Record<AiProvider, ProviderAuthCheck>> = {
  'claude-code': {
    kind: 'json-field',
    args: ['auth', 'status'],
    field: 'loggedIn',
    hint: 'run `claude auth login` (or `/login` inside claude) to sign in',
  },
  'openai-codex': {
    kind: 'exit-code',
    args: ['login', 'status'],
    hint: 'run `codex login` to sign in',
  },
  opencode: {
    kind: 'credential-count',
    args: ['providers', 'list'],
  },
  'github-copilot': {
    kind: 'none',
    reason: 'the copilot CLI exposes no non-interactive auth-status verb — sign in with `/login` inside `copilot`',
  },
};

// Strips the ANSI CSI escape prefix opencode decorates its CLI output with, before parsing.
// eslint-disable-next-line no-control-regex -- deliberate: matching the literal ESC byte.
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*m/g, '');

const UNKNOWN_SUBCOMMAND_PATTERN =
  /unknown (sub)?command|unrecognized (sub)?command|no such (sub)?command|invalid (sub)?command/i;

const looksLikeUnknownSubcommand = (stderr: string): boolean => UNKNOWN_SUBCOMMAND_PATTERN.test(stderr);

const firstNonEmptyLine = (text: string): string | undefined =>
  text
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim();

/**
 * Parse `{ [field]: boolean, authMethod?: string }` off stdout. Deliberately reads only
 * `field` and `authMethod` — any other property (email, subscriptionType, …) is ignored so it
 * can never surface in a probe detail.
 */
const parseJsonFieldAuth = (
  stdout: string,
  field: string
): { readonly loggedIn: boolean; readonly authMethod?: string } | undefined => {
  try {
    const parsed: unknown = JSON.parse(stripAnsi(stdout));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const value = record[field];
    if (typeof value !== 'boolean') return undefined;
    const authMethod = typeof record.authMethod === 'string' ? record.authMethod : undefined;
    return { loggedIn: value, ...(authMethod !== undefined ? { authMethod } : {}) };
  } catch {
    return undefined;
  }
};

/** Parse the "N credentials" tail `opencode providers list` prints. */
const parseCredentialCount = (stdout: string): number | undefined => {
  const match = /(\d+)\s+credentials?/i.exec(stripAnsi(stdout));
  if (match === null || match[1] === undefined) return undefined;
  return Number.parseInt(match[1], 10);
};

const probeJsonFieldAuth = async (
  id: string,
  label: string,
  binary: string,
  check: JsonFieldAuthCheck,
  runCommand: RunCommand
): Promise<ProbeResult> => {
  const r = await runCommand(binary, check.args);
  const parsed = parseJsonFieldAuth(r.stdout, check.field);
  if (parsed === undefined) {
    return mkProbe(id, label, 'unknown', `could not parse \`${binary} ${check.args.join(' ')}\` output`, 'ai');
  }
  if (parsed.loggedIn) {
    const detail =
      parsed.authMethod !== undefined ? `authenticated (authMethod: ${parsed.authMethod})` : 'authenticated';
    return mkProbe(id, label, 'pass', detail, 'ai');
  }
  return mkProbe(id, label, 'warn', 'not logged in', 'ai', check.hint);
};

const probeExitCodeAuth = async (
  id: string,
  label: string,
  binary: string,
  check: ExitCodeAuthCheck,
  runCommand: RunCommand
): Promise<ProbeResult> => {
  const r = await runCommand(binary, check.args);
  if (r.ok) return mkProbe(id, label, 'pass', 'authenticated', 'ai');
  if (looksLikeUnknownSubcommand(r.stderr)) {
    return mkProbe(id, label, 'unknown', 'auth-status subcommand not recognised by this CLI version', 'ai');
  }
  const detail = firstNonEmptyLine(r.stderr) ?? 'not authenticated';
  return mkProbe(id, label, 'warn', detail, 'ai', check.hint);
};

const probeCredentialCountAuth = async (
  id: string,
  label: string,
  binary: string,
  check: CredentialCountAuthCheck,
  runCommand: RunCommand
): Promise<ProbeResult> => {
  const r = await runCommand(binary, check.args);
  const count = parseCredentialCount(r.stdout);
  if (count === undefined) {
    return mkProbe(id, label, 'unknown', 'could not determine credential count', 'ai');
  }
  if (count >= 1) {
    return mkProbe(id, label, 'pass', `${String(count)} credential(s) configured`, 'ai');
  }
  return mkProbe(id, label, 'unknown', '0 credentials configured — the free tier works without one', 'ai');
};

/**
 * Probe whether `provider`'s CLI is authenticated. Callers are expected to only invoke this for
 * a provider that is both configured and already known to be on `PATH` — `kind: 'none'`
 * providers never spawn regardless.
 */
export const probeProviderAuth = async (provider: AiProvider, runCommand: RunCommand): Promise<ProbeResult> => {
  const id = `ai-auth-${provider}`;
  const label = `${PROVIDER_LABEL[provider]} authenticated`;
  const check = PROVIDER_AUTH_CHECK[provider];
  const binary = PROVIDER_BINARY[provider];

  switch (check.kind) {
    case 'none':
      return mkProbe(id, label, 'unknown', check.reason, 'ai');
    case 'json-field':
      return probeJsonFieldAuth(id, label, binary, check, runCommand);
    case 'exit-code':
      return probeExitCodeAuth(id, label, binary, check, runCommand);
    case 'credential-count':
      return probeCredentialCountAuth(id, label, binary, check, runCommand);
  }
};
