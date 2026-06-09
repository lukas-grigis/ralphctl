import { dirname, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { writeJsonAtomic, writeTextAtomic } from '@src/integration/io/fs.ts';

/**
 * Test fake for {@link HeadlessAiProvider}. Drives chain tests without spawning a real AI
 * session. Mirrors the production file-based contract: signals are written to
 * `session.signalsFile`; the return shape matches {@link ProviderOutput}.
 *
 * ## Dispatch
 *
 * Inspects the prompt body to pick which scripted template to apply, matched by a per-template
 * marker substring (see {@link MARKERS}). Tests can override markers via `markerOverrides`.
 *
 * ## Producing signals
 *
 * Tests author signals explicitly via `signals[templateName]`. Production providers no longer
 * parse stdout for XML-marker shortcuts — the audit-[09] contract has the AI write
 * `signals.json` directly — so this fake mirrors that by writing whatever signal array the
 * test supplies to `session.signalsFile`. Missing entries serialise to `[]`.
 *
 * ## Body text
 *
 * `responses[templateName]` is an optional opaque body string (or `(session) => body`) the
 * fake mirrors to `session.bodyFile` when one is configured. Tests that exercise forensic
 * `body.txt` paths (e.g. `detect-skills` raw-AI-body surfacing) supply this; tests that only
 * care about signal handling can omit it.
 *
 * ## Session ids
 *
 * `sessionIds[templateName]` is threaded onto `ProviderOutput.sessionId` AND written to
 * `<dirname-of-signalsFile>/session-id.txt` as a sibling text file — mirroring the production
 * Claude adapter's `persistSessionIdFile` contract so leaves that read the file
 * (`readRoundSessionId`) see the captured id without manual test setup. `sessionIds[templateName]` may be a string
 * (same id every call) or a function `(session) => string | undefined` (per-call ids, e.g. for
 * round-1-vs-round-2 resume tests where each round produces its own id).
 *
 * ## Inspecting calls
 *
 * `recordedSessions` accumulates the `AiSession` descriptor of every call in invocation order.
 * Tests asserting "round N forwarded resume=X" read from this array.
 */
export interface FakeAiProviderScript {
  /**
   * Optional opaque body strings (or producers) per template name. Mirrored to
   * `session.bodyFile` when configured — does NOT contribute signals (use `signals` for that).
   */
  readonly responses?: Record<string, string | ((session: AiSession) => string)>;
  /**
   * Signal arrays the fake writes to `session.signalsFile`, keyed by template. Tests author
   * the exact `HarnessSignal[]` payload they want the leaf to see. Missing entries serialise
   * to `[]`.
   */
  readonly signals?: Record<string, readonly HarnessSignal[] | ((session: AiSession) => readonly HarnessSignal[])>;
  /** Optional scripted session ids per template name. String = constant; function = per-call. */
  readonly sessionIds?: Record<string, string | ((session: AiSession) => string | undefined)>;
  /**
   * Optional override of the marker map. Merged on top of {@link MARKERS}. Tests that add a
   * new template can register its marker without modifying this file.
   */
  readonly markerOverrides?: Readonly<Record<string, string>>;
}

/**
 * Provider interface plus a mutable `recordedSessions` array — the array fills up over the
 * lifetime of the fake. Tests can spread this into their `provider` slot and still read the
 * inspection array.
 */
export interface FakeAiProvider extends HeadlessAiProvider {
  readonly recordedSessions: readonly AiSession[];
}

/**
 * Distinctive role-line substrings for the bundled prompt templates. Most templates open with a
 * `<role>` block instead of a Markdown H1; markers therefore match a unique phrase from that
 * block rather than a heading. `implement` keeps its `# Task Execution Protocol` H1.
 */
export const MARKERS: Readonly<Record<string, string>> = {
  refine: 'requirements analyst working interactively',
  plan: 'task planning specialist',
  // Continuation markers MUST precede their full counterparts in this map: dispatch returns the
  // FIRST matching marker, and the evaluate-continuation role block re-states "independent code
  // reviewer" (so it would otherwise be misdispatched as `evaluate`). The continuation H1s are
  // unique, so listing them first resolves the overlap deterministically.
  'implement-continuation': '# Continue — Round',
  'evaluate-continuation': '# Re-evaluate — Round',
  implement: '# Task Execution Protocol',
  evaluate: 'independent code reviewer',
  readiness: 'project context file proposal',
  'apply-feedback': 'applying one round of human review feedback',
  'detect-skills': 'author two short coding-agent skills',
  'detect-scripts': 'inventorying a single repository',
};

const dispatchTemplate = (body: string, markers: Readonly<Record<string, string>>): string | undefined => {
  for (const [templateName, marker] of Object.entries(markers)) {
    if (body.includes(marker)) return templateName;
  }
  return undefined;
};

export const createFakeAiProvider = (script: FakeAiProviderScript): FakeAiProvider => {
  const markers: Readonly<Record<string, string>> = {
    ...MARKERS,
    ...(script.markerOverrides ?? {}),
  };
  const recordedSessions: AiSession[] = [];

  return {
    recordedSessions,
    async generate(session: AiSession) {
      recordedSessions.push(session);
      const templateName = dispatchTemplate(session.prompt as unknown as string, markers);
      if (templateName === undefined) {
        return Result.error(
          new InvalidStateError({
            entity: 'fake-ai-provider',
            currentState: 'no-marker-match',
            attemptedAction: 'generate',
            message:
              'fake HeadlessAiProvider: no template marker matched the prompt body. Add a marker via `markerOverrides` or fix the prompt.',
          })
        ) as Result<ProviderOutput, DomainError>;
      }

      const signalsEntry = script.signals?.[templateName];
      const signals: readonly HarnessSignal[] =
        typeof signalsEntry === 'function' ? signalsEntry(session) : (signalsEntry ?? []);

      const wrote = await writeJsonAtomic(String(session.signalsFile), signals);
      if (!wrote.ok) return Result.error(wrote.error) as Result<ProviderOutput, DomainError>;

      // Mirror Claude's bodyFile contract so tests covering forensic-artifact paths see a real
      // body.txt on disk. Best-effort: a write failure is treated as warn-equivalent (production
      // claude-headless logs at warn and proceeds) — surfacing it would break tests that don't
      // care about the body file.
      if (session.bodyFile !== undefined) {
        const responseEntry = script.responses?.[templateName];
        const body = typeof responseEntry === 'function' ? responseEntry(session) : (responseEntry ?? '');
        await writeTextAtomic(String(session.bodyFile), body);
      }

      const sessionIdEntry = script.sessionIds?.[templateName];
      const sessionId = typeof sessionIdEntry === 'function' ? sessionIdEntry(session) : sessionIdEntry;
      // Mirror Claude's `persistSessionIdFile` contract: when a sessionId is captured, write a
      // sibling `session-id.txt` text file next to signals.json so leaves reading via
      // `readRoundSessionId` see the same file shape production produces.
      if (sessionId !== undefined && sessionId.length > 0) {
        const sidPath = join(dirname(String(session.signalsFile)), 'session-id.txt');
        await writeTextAtomic(sidPath, `${sessionId}\n`);
      }
      return Result.ok({
        signalsFile: session.signalsFile,
        exitCode: 0,
        ...(sessionId !== undefined ? { sessionId } : {}),
      }) as Result<ProviderOutput, DomainError>;
    },
  };
};
