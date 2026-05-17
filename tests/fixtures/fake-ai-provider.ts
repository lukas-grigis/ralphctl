import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import { parseHarnessSignals } from '@src/integration/ai/signals/_engine/parse-signals.ts';

/**
 * Test fake for {@link HeadlessAiProvider}. Drives chain tests without spawning a real AI
 * session. Mirrors the production file-based contract: signals are written to
 * `session.signalsFile`; the return shape matches {@link ProviderOutput}.
 *
 * ## Dispatch
 *
 * Inspects the prompt body to pick which scripted response to return, matched by a per-template
 * marker substring (see {@link MARKERS}). Tests can override markers via `markerOverrides`.
 *
 * ## Producing signals
 *
 * Two layered mechanisms keep existing tests compact while the contract is file-based:
 *
 *   1. `responses[templateName]` (raw body or `(session) => body` fn): the fake feeds the body
 *      through `parseHarnessSignals(...)` and writes the resulting array to `session.signalsFile`.
 *      Tests that previously baked `<task-verified>…</task-verified>` into the response keep
 *      working — they now produce real `task-verified` signals on disk via the real parser.
 *   2. `signals[templateName]`: explicit signal arrays. Appended AFTER the parsed body's signals.
 *      Use when the desired signals can't be expressed through the production parsers (e.g. a
 *      `<commit-message>` with a structured body the parser would normalise).
 *
 * `sessionIds[templateName]` is threaded onto `ProviderOutput.sessionId`.
 */
export interface FakeAiProviderScript {
  /** Map prompt-template-name → response body (string) or producer. The body is parsed for signals. */
  readonly responses?: Record<string, string | ((session: AiSession) => string)>;
  /** Optional explicit signal arrays appended after the parsed-body signals, keyed by template. */
  readonly signals?: Record<string, readonly HarnessSignal[]>;
  /** Optional scripted session ids per template name. */
  readonly sessionIds?: Record<string, string>;
  /**
   * Optional override of the marker map. Merged on top of {@link MARKERS}. Tests that add a
   * new template can register its marker without modifying this file.
   */
  readonly markerOverrides?: Readonly<Record<string, string>>;
}

/** Title-line markers for the bundled prompt templates. */
export const MARKERS: Readonly<Record<string, string>> = {
  refine: '# Requirements Refinement Protocol',
  plan: '# Interactive Task Planning Protocol',
  implement: '# Task Execution Protocol',
  evaluate: '# Code Review:',
  readiness: '# Repository Readiness Protocol',
  'apply-feedback': '# Apply Feedback Protocol',
  'detect-skills': '# Detect Skills Protocol',
  'detect-scripts': '# Detect Scripts Protocol',
};

const dispatchTemplate = (body: string, markers: Readonly<Record<string, string>>): string | undefined => {
  for (const [templateName, marker] of Object.entries(markers)) {
    if (body.includes(marker)) return templateName;
  }
  return undefined;
};

export const createFakeAiProvider = (script: FakeAiProviderScript): HeadlessAiProvider => {
  const markers: Readonly<Record<string, string>> = {
    ...MARKERS,
    ...(script.markerOverrides ?? {}),
  };

  return {
    async generate(session: AiSession) {
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

      const responseEntry = script.responses?.[templateName];
      const body = typeof responseEntry === 'function' ? responseEntry(session) : (responseEntry ?? '');
      const parsedSignals = parseHarnessSignals(body, IsoTimestamp.now());
      const extraSignals = script.signals?.[templateName] ?? [];
      const allSignals = [...parsedSignals, ...extraSignals];

      const wrote = await writeJsonAtomic(String(session.signalsFile), allSignals);
      if (!wrote.ok) return Result.error(wrote.error) as Result<ProviderOutput, DomainError>;

      const sessionId = script.sessionIds?.[templateName];
      return Result.ok({
        signalsFile: session.signalsFile,
        exitCode: 0,
        ...(sessionId !== undefined ? { sessionId } : {}),
      }) as Result<ProviderOutput, DomainError>;
    },
  };
};
