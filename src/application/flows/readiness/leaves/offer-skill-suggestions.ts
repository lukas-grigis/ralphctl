import { Result } from '@src/domain/result.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';

/**
 * Human-gated handler for the AI's `skill-suggestions` signal. The propose leaf captures the
 * suggested kebab-case skill names onto `ctx.entries[tool].proposal.proposedSkillSuggestions`;
 * this leaf walks them and, per name, asks the operator before touching the repo:
 *
 *  - **Known** (the name resolves to a bundled skill via {@link SkillSource.getByName}) →
 *    `askConfirm` "install?". On yes, the canonical bundled body is written into the repo's
 *    `<parentDir>/skills/<name>/SKILL.md` via {@link SkillsAdapter.installBareSkill}.
 *  - **Unknown** (no bundled skill of that name) → `askConfirm` "scaffold a stub?". On yes, a
 *    minimal-frontmatter stub is written to the same location for the operator to flesh out.
 *
 * The human gate is MANDATORY — nothing is ever auto-installed. A `false` answer skips that
 * one name; a prompt error (including `AbortError` on Ctrl-C) propagates verbatim so a
 * cancellation aborts the chain rather than being swallowed.
 *
 * Like its siblings {@link writeReadinessLeaf} and {@link installReadinessSkillsLeaf}, this leaf
 * is gated on the entry's `accepted` flag: when the operator declined the overall readiness
 * proposal for this tool, the leaf is a logged no-op — declining the proposal also declines its
 * suggested skills, so the operator is never prompted to install anything off a rejected round.
 *
 * Empty / undefined suggestions, a missing repository path, or a declined proposal make the
 * leaf a logged no-op.
 *
 * Like {@link installReadinessSkillsLeaf}, installs go through the BARE-name adapter path: the
 * folders are deliberately project-tracked (no `ralphctl-` prefix, no `.git/info/exclude`
 * entry) so the operator commits them as regular project assets and owns their lifecycle.
 */
export interface OfferSkillSuggestionsLeafDeps {
  readonly interactive: InteractivePrompt;
  readonly skillSource: SkillSource;
  readonly skillsAdapter: SkillsAdapter;
  readonly logger: Logger;
}

interface OfferSkillSuggestionsInput {
  readonly accepted: boolean;
  readonly suggestions: readonly string[];
  readonly repoPath?: AbsolutePath;
}

/**
 * Minimal stub for an unrecognised suggestion. Carries only the spec-required `name` /
 * `description` frontmatter plus a one-line body inviting the operator to flesh it out — the
 * adapter renders the frontmatter, so the on-disk file is a valid, editable Agent Skill.
 */
const stubSkillFor = (name: string): Skill => ({
  name,
  description: `Project skill '${name}' (stub) — describe when this skill applies and edit the body below.`,
  content: `# ${name}\n\n> Stub scaffolded by ralphctl from an AI skill suggestion. Replace this body with the skill's guidance.\n`,
});

/**
 * Human-gate one suggested skill name: resolve it against the bundled source, ask the operator,
 * and install the canonical bundled body (known) or a scaffolded stub (unknown) on approval. A
 * `false` answer is a clean skip; a prompt error (incl. `AbortError`) propagates verbatim.
 */
const offerOne = async (
  deps: OfferSkillSuggestionsLeafDeps,
  log: ReturnType<Logger['named']>,
  repoPath: AbsolutePath,
  name: string
): Promise<Result<void, DomainError>> => {
  const found = await deps.skillSource.getByName(name);
  if (!found.ok) return Result.error(found.error);
  const bundled = found.value;
  const known = bundled !== undefined;

  const message = known
    ? `The AI suggests the bundled skill '${name}'. Install it into ${String(repoPath)}?`
    : `The AI suggests an unknown skill '${name}'. Scaffold a stub for it in ${String(repoPath)}?`;
  const answer = await deps.interactive.askConfirm({ message });
  // Propagate any prompt error verbatim — `AbortError` (Ctrl-C) must abort the chain, not be
  // treated as a decline.
  if (!answer.ok) return Result.error(answer.error);
  if (!answer.value) {
    log.info(`operator declined skill '${name}' — skipping`);
    return Result.ok(undefined);
  }

  const skill = bundled ?? stubSkillFor(name);
  const installed = await deps.skillsAdapter.installBareSkill(repoPath, skill);
  if (!installed.ok) return Result.error(installed.error);
  log.info(known ? `installed bundled skill '${name}'` : `scaffolded stub skill '${name}'`);
  return Result.ok(undefined);
};

const offerSkillSuggestionsUseCase = async (
  deps: OfferSkillSuggestionsLeafDeps,
  tool: AssistantTool,
  input: OfferSkillSuggestionsInput
): Promise<Result<void, DomainError>> => {
  const log = deps.logger.named(`readiness.offer-skill-suggestions-${tool}`);
  if (!input.accepted) {
    log.info('skipping skill suggestions — proposal not accepted');
    return Result.ok(undefined);
  }
  if (input.suggestions.length === 0) {
    log.info('no skill suggestions to offer — skipping');
    return Result.ok(undefined);
  }
  const repoPath = input.repoPath;
  if (repoPath === undefined) {
    log.info('skipping skill suggestions — no repository path on ctx');
    return Result.ok(undefined);
  }

  for (const name of input.suggestions) {
    const offered = await offerOne(deps, log, repoPath, name);
    if (!offered.ok) return Result.error(offered.error);
  }

  return Result.ok(undefined);
};

export const offerSkillSuggestionsLeaf = (
  deps: OfferSkillSuggestionsLeafDeps,
  tool: AssistantTool
): Element<ReadinessCtx> =>
  leaf<ReadinessCtx, OfferSkillSuggestionsInput, void>(`offer-skill-suggestions-${tool}`, {
    useCase: {
      execute: async (input) => offerSkillSuggestionsUseCase(deps, tool, input),
    },
    input: (ctx) => {
      const entry = ctx.entries[tool];
      const suggestions = entry?.proposal?.proposedSkillSuggestions ?? [];
      return {
        accepted: entry?.accepted ?? false,
        suggestions,
        ...(ctx.repository?.path !== undefined ? { repoPath: ctx.repository.path } : {}),
      };
    },
    output: (ctx) => ctx,
  });
