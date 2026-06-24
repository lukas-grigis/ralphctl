/**
 * Pre-launch repository-selection step — unit tests for `runRepositorySelection` and the
 * `flowSelectsRepository` gate.
 *
 * The step is what turns the session repo-pin from a HARD lock into a SOFT default: on every
 * launch of a repo-selecting flow against a multi-repo project, the user re-picks the
 * repository with the previously-pinned repo offered first (default highlight). The behaviour
 * under test:
 *  - Multi-repo + repo-selecting flow → prompts; the chosen repo's id is returned. Launching
 *    AGAIN in the same session re-prompts (no lock) with the pinned repo offered first.
 *  - Single-repo project → no prompt (kind 'skip'); the chain auto-selects the lone repo.
 *  - Non-repo-selecting flow (refine / plan / implement) → no prompt (kind 'skip').
 *  - Cancel (Esc → AbortError on the Result channel) → kind 'cancel'; the launcher must not run.
 *
 * Driven by a scripted {@link InteractivePrompt} fake (mirroring `flows-customize-picker.test`)
 * so each assertion sees the exact prompt sequence without an Ink mount / stdin keystrokes.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Slug } from '@src/domain/value/slug.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { createRepository, type Repository } from '@src/domain/entity/repository.ts';
import type { Project } from '@src/domain/entity/project.ts';
import {
  flowSelectsRepository,
  runRepositorySelection,
} from '@src/application/ui/tui/views/flows-repository-picker.ts';

const makeRepo = (name: string, dir: string): Repository => {
  const path = AbsolutePath.parse(dir);
  if (!path.ok) throw new Error(`fixture: bad path ${dir}`);
  const slug = Slug.parse(name.toLowerCase());
  if (!slug.ok) throw new Error(`fixture: bad slug ${name}`);
  const repo = createRepository({ path: path.value, name, slug: slug.value });
  if (!repo.ok) throw new Error(`fixture: repo build failed: ${repo.error.message}`);
  return repo.value;
};

const REPO_A = makeRepo('alpha', '/tmp/alpha');
const REPO_B = makeRepo('beta', '/tmp/beta');
const REPO_C = makeRepo('gamma', '/tmp/gamma');

const makeProject = (repositories: readonly Repository[]): Project =>
  ({ slug: 'fixture-project', displayName: 'Fixture Project', repositories }) as unknown as Project;

interface CapturedPrompt {
  readonly message: string;
  readonly options: readonly string[];
}

/**
 * Script-driven {@link InteractivePrompt}. Each `askChoice` consumes the next script entry —
 * a `RepositoryId` resolves to the option whose value carries that id; `'cancel'` resolves to
 * an `AbortError` on the Result error channel (mirroring the Ink adapter on Esc). The captured
 * prompts are returned so tests can assert the message and option ORDER (pinned-repo-first).
 */
type ScriptEntry = RepositoryId | 'cancel';

const buildScriptedPrompt = (
  script: readonly ScriptEntry[]
): { readonly interactive: InteractivePrompt; readonly captured: CapturedPrompt[] } => {
  const captured: CapturedPrompt[] = [];
  let cursor = 0;
  const fail = () => {
    throw new Error('unexpected prompt method on repository-picker scripted prompt');
  };
  const interactive: InteractivePrompt = {
    askText: fail,
    askTextArea: fail,
    askConfirm: fail,
    askMultiChoice: fail,
    async askChoice<T>(message: string, options: ReadonlyArray<Choice<T>>) {
      captured.push({ message, options: options.map((o) => o.label) });
      const entry = script[cursor];
      cursor += 1;
      if (entry === undefined) throw new Error(`scripted prompt exhausted at: ${message}`);
      if (entry === 'cancel') {
        return Result.error(new AbortError({ elementName: 'test', reason: 'scripted cancel' })) as unknown as Result<
          T,
          DomainError
        >;
      }
      const found = options.find((o) => (o.value as { readonly id?: RepositoryId }).id === entry);
      if (found === undefined) throw new Error(`scripted prompt: repo id ${String(entry)} not in options`);
      return Result.ok(found.value) as unknown as Result<T, DomainError>;
    },
  };
  return { interactive, captured };
};

describe('flowSelectsRepository — gate', () => {
  it('returns true only for the three flows that run pickRepositoryLeaf', () => {
    for (const id of ['detect-scripts', 'detect-skills', 'readiness']) {
      expect(flowSelectsRepository(id)).toBe(true);
    }
    for (const id of ['refine', 'plan', 'implement', 'ideate', 'create-sprint', 'doctor', 'create-pr']) {
      expect(flowSelectsRepository(id)).toBe(false);
    }
  });
});

describe('runRepositorySelection — multi-repo + repo-selecting flow', () => {
  it('prompts and returns the chosen repository id', async () => {
    const { interactive, captured } = buildScriptedPrompt([REPO_B.id]);
    const result = await runRepositorySelection({
      interactive,
      flowId: 'detect-scripts',
      flowTitle: 'Detect scripts',
      project: makeProject([REPO_A, REPO_B, REPO_C]),
      pinnedRepositoryId: undefined,
    });
    expect(result).toEqual({ kind: 'selected', repositoryId: REPO_B.id });
    // Exactly one prompt, message names the flow, options mirror pick-repository rendering.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.message).toContain('Detect scripts');
    expect(captured[0]?.options).toEqual([
      `${REPO_A.name} (${String(REPO_A.slug)})`,
      `${REPO_B.name} (${String(REPO_B.slug)})`,
      `${REPO_C.name} (${String(REPO_C.slug)})`,
    ]);
  });

  it('offers the session-pinned repo FIRST (default highlight) when set', async () => {
    // Pin beta — it must appear first so it is the default highlighted option, the rest keep
    // project order. This is the "soft default" behaviour: the lock is gone but the prior
    // choice is still the path of least resistance.
    const { interactive, captured } = buildScriptedPrompt([REPO_A.id]);
    const result = await runRepositorySelection({
      interactive,
      flowId: 'readiness',
      flowTitle: 'Readiness',
      project: makeProject([REPO_A, REPO_B, REPO_C]),
      pinnedRepositoryId: REPO_B.id,
    });
    expect(result).toEqual({ kind: 'selected', repositoryId: REPO_A.id });
    expect(captured[0]?.options[0]).toBe(`${REPO_B.name} (${String(REPO_B.slug)})`);
    // The remaining options keep project order.
    expect(captured[0]?.options.slice(1)).toEqual([
      `${REPO_A.name} (${String(REPO_A.slug)})`,
      `${REPO_C.name} (${String(REPO_C.slug)})`,
    ]);
  });

  it('re-prompts on a second launch in the same session (no lock) and a different repo can flow through', async () => {
    const project = makeProject([REPO_A, REPO_B, REPO_C]);
    // First launch: pick alpha (nothing pinned yet).
    const first = buildScriptedPrompt([REPO_A.id]);
    const r1 = await runRepositorySelection({
      interactive: first.interactive,
      flowId: 'detect-skills',
      flowTitle: 'Detect skills',
      project,
      pinnedRepositoryId: undefined,
    });
    expect(r1).toEqual({ kind: 'selected', repositoryId: REPO_A.id });

    // Second launch: the pin (alpha) is now offered first, but the user is STILL prompted and
    // can pick a different repo (gamma) — proving the repo is no longer locked.
    const second = buildScriptedPrompt([REPO_C.id]);
    const r2 = await runRepositorySelection({
      interactive: second.interactive,
      flowId: 'detect-skills',
      flowTitle: 'Detect skills',
      project,
      pinnedRepositoryId: REPO_A.id,
    });
    expect(second.captured).toHaveLength(1);
    expect(second.captured[0]?.options[0]).toBe(`${REPO_A.name} (${String(REPO_A.slug)})`);
    expect(r2).toEqual({ kind: 'selected', repositoryId: REPO_C.id });
  });

  it('cancel (Esc → AbortError) → kind cancel; the launcher must not launch', async () => {
    const { interactive, captured } = buildScriptedPrompt(['cancel']);
    const result = await runRepositorySelection({
      interactive,
      flowId: 'readiness',
      flowTitle: 'Readiness',
      project: makeProject([REPO_A, REPO_B]),
      pinnedRepositoryId: undefined,
    });
    expect(result).toEqual({ kind: 'cancel' });
    expect(captured).toHaveLength(1);
  });
});

describe('runRepositorySelection — skip paths (no prompt)', () => {
  const failingPrompt: InteractivePrompt = {
    askText: () => {
      throw new Error('no prompt expected');
    },
    askTextArea: () => {
      throw new Error('no prompt expected');
    },
    askConfirm: () => {
      throw new Error('no prompt expected');
    },
    askMultiChoice: () => {
      throw new Error('no prompt expected');
    },
    askChoice: () => {
      throw new Error('no prompt expected on a skip path');
    },
  };

  it('single-repo project → kind skip (the chain auto-selects the lone repo)', async () => {
    const result = await runRepositorySelection({
      interactive: failingPrompt,
      flowId: 'detect-scripts',
      flowTitle: 'Detect scripts',
      project: makeProject([REPO_A]),
      pinnedRepositoryId: undefined,
    });
    expect(result).toEqual({ kind: 'skip' });
  });

  it('zero-repo project → kind skip (pickRepositoryLeaf surfaces its own empty-project error)', async () => {
    const result = await runRepositorySelection({
      interactive: failingPrompt,
      flowId: 'readiness',
      flowTitle: 'Readiness',
      project: makeProject([]),
      pinnedRepositoryId: undefined,
    });
    expect(result).toEqual({ kind: 'skip' });
  });

  it('undefined project → kind skip', async () => {
    const result = await runRepositorySelection({
      interactive: failingPrompt,
      flowId: 'detect-skills',
      flowTitle: 'Detect skills',
      project: undefined,
      pinnedRepositoryId: undefined,
    });
    expect(result).toEqual({ kind: 'skip' });
  });

  it('non-repo-selecting flow (refine / plan / implement) → kind skip even on a multi-repo project', async () => {
    for (const flowId of ['refine', 'plan', 'implement', 'ideate', 'create-sprint']) {
      const result = await runRepositorySelection({
        interactive: failingPrompt,
        flowId,
        flowTitle: flowId,
        project: makeProject([REPO_A, REPO_B, REPO_C]),
        pinnedRepositoryId: REPO_B.id,
      });
      expect(result).toEqual({ kind: 'skip' });
    }
  });
});
