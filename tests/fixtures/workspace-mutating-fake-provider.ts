/**
 * Composable fake {@link HeadlessAiProvider} that writes real files into `session.cwd` and then
 * delegates signal / sessionId / body handling to the inner {@link createFakeAiProvider}.
 *
 * ## Design
 *
 * The implement chain requires the working tree to be dirty after the generator runs (the
 * commit leaf stages and commits whatever files the AI wrote). A plain `createFakeAiProvider`
 * does not touch the filesystem, so the commit leaf finds a clean tree and refuses to commit.
 * This wrapper adds a `fileWrites` map that describes exactly what files to create, keyed by
 * template name (matched the same way `createFakeAiProvider` dispatches on MARKERS).
 *
 * ## Usage
 *
 *     const provider = createWorkspaceMutatingFakeProvider({
 *       fileWrites: {
 *         implement: { 'output.txt': 'task output\n' },
 *       },
 *       signals: {
 *         implement: [taskVerified('done')],
 *         evaluate: [evaluationPassed()],
 *       },
 *     });
 *
 * ## Promoted from implement-parallel-realgit.test.ts
 *
 * The anonymous `createRealFileWritingProvider` in that test performed the same write-then-signal
 * pattern. This fixture promotes it into a reusable, script-driven shape so full-stack tests can
 * express their intended AI output declaratively without re-implementing the file-write mechanics.
 *
 * The `implement-parallel-realgit` test has been refactored to delegate its file-write logic to
 * this fixture while keeping its per-task dispatch (via `session.cwd`) in-test.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { FakeAiProviderScript, FakeAiProvider } from './fake-ai-provider.ts';
import { createFakeAiProvider, MARKERS } from './fake-ai-provider.ts';

/**
 * Options for {@link createWorkspaceMutatingFakeProvider}. Extends {@link FakeAiProviderScript}
 * with an additional `fileWrites` map describing which files to create under `session.cwd` per
 * template. All `FakeAiProviderScript` options (signals, responses, sessionIds, markerOverrides)
 * still work exactly as in `createFakeAiProvider`.
 */
export interface WorkspaceMutatingFakeProviderScript extends FakeAiProviderScript {
  /**
   * Files to write under `session.cwd`, keyed by template name. Each value is a map from
   * relative path (relative to `session.cwd`) to file content. Example:
   *
   *     fileWrites: {
   *       implement: { 'output.txt': 'generated content\n' },
   *     }
   *
   * File parents are created automatically. Files are written BEFORE the inner fake's signal
   * writing so the signals reflect a post-write state (matching production behaviour where the
   * AI writes files, then signals.json).
   */
  readonly fileWrites?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Provider interface with the `FakeAiProvider.recordedSessions` inspection array. */
export interface WorkspaceMutatingFakeProvider extends HeadlessAiProvider {
  readonly recordedSessions: FakeAiProvider['recordedSessions'];
}

/**
 * Dispatch the template name from the prompt body using the same MARKERS map `createFakeAiProvider`
 * uses, merged with any `markerOverrides` in the script.
 */
const dispatchTemplate = (body: string, script: FakeAiProviderScript): string | undefined => {
  const markers: Readonly<Record<string, string>> = { ...MARKERS, ...(script.markerOverrides ?? {}) };
  for (const [name, marker] of Object.entries(markers)) {
    if (body.includes(marker)) return name;
  }
  return undefined;
};

/**
 * Build a workspace-mutating fake provider. On each `generate()` call:
 *  1. Dispatches the template name from the prompt body.
 *  2. Writes any `fileWrites[templateName]` entries into `session.cwd`.
 *  3. Delegates the rest (signals.json, body file, session-id.txt) to the inner fake.
 */
export const createWorkspaceMutatingFakeProvider = (
  script: WorkspaceMutatingFakeProviderScript
): WorkspaceMutatingFakeProvider => {
  const inner: FakeAiProvider = createFakeAiProvider(script);

  return {
    get recordedSessions() {
      return inner.recordedSessions;
    },
    async generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>> {
      // Identify which template this call is for.
      const templateName = dispatchTemplate(session.prompt as unknown as string, script);

      // Write scripted files into session.cwd before the inner fake writes signals.
      if (templateName !== undefined && script.fileWrites !== undefined) {
        const writes = script.fileWrites[templateName];
        if (writes !== undefined) {
          for (const [relPath, content] of Object.entries(writes)) {
            const fullPath = join(String(session.cwd), relPath);
            const parentDir = fullPath.slice(0, fullPath.lastIndexOf('/'));
            if (parentDir.length > 0) {
              await fs.mkdir(parentDir, { recursive: true });
            }
            await fs.writeFile(fullPath, content, 'utf8');
          }
        }
      }

      return inner.generate(session);
    },
  };
};
