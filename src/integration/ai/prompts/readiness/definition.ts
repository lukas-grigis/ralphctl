import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import { isPresent } from '@src/integration/ai/readiness/_engine/predicates.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Pre-rendered string parameters for the readiness template. The renderer helpers below produce
 * each block from domain types; callers can also build the strings by hand for tests.
 *
 * Parameters:
 *  - `repositoryPath` — absolute path to the repo the AI is inventorying.
 *  - `currentTool` — the {@link AssistantTool} the harness is targeting, rendered as its string
 *    discriminant (claude-code / copilot / codex). Pre-rendered to a string so the
 *    `ParameterSpec<string>` validator can be uniform across every parameter.
 *  - `wireTag` — the XML tag name the AI should emit around its proposed body. Tool-specific so
 *    Claude sees `<claude-md>` (writing to CLAUDE.md), Copilot sees `<copilot-instructions>`,
 *    and Codex sees `<agents-md>` (its native cross-tool spec name). Computed from
 *    `currentTool` via {@link wireTagFor}.
 *  - `existingContextFile` — the existing context-file body when one was found, or an explicit
 *    "no existing file" line. The "preserve verbatim" constraint in the template fires on a
 *    non-empty body.
 *  - `detectedArtefacts` — bullet list of artefact paths discovered by the probe, or an explicit
 *    "no artefacts detected" line when the probe came back absent.
 *  - `targetFileConventions` — per-provider style guide for the target context file (CLAUDE.md /
 *    `.github/copilot-instructions.md` / AGENTS.md). Loaded from the matching conventions
 *    partial via {@link conventionsPartialName} and passed as a rendered string so the template
 *    can embed it inside `<target_file_conventions>` before the output contract section.
 */
export interface ReadinessPromptParams {
  readonly repositoryPath: string;
  readonly currentTool: string;
  readonly wireTag: string;
  readonly existingContextFile: string;
  readonly detectedArtefacts: string;
  /**
   * Per-provider style guide body — loaded from the conventions partial selected by
   * {@link conventionsPartialName}. Placed in the template before `<output_contract>` so the
   * AI reads format conventions before it sees the output shape.
   */
  readonly targetFileConventions: string;
  /**
   * Audit-[09] output contract section — rendered from the readiness `AiOutputContract` by
   * `renderContractSectionFor(readinessOutputContract)`. Tells the AI to write `signals.json`
   * directly with one or more of `agents-md-proposal`, `setup-skill-proposal`,
   * `verify-skill-proposal`, plus optional `skill-suggestions` / `note` / `learning`.
   */
  readonly outputContractSection: string;
}

const CLAUDE_CODE = 'claude-code';

/**
 * Map an {@link AssistantTool} to the XML tag the AI should emit around its proposed body.
 * Each tag matches what the harness will write to disk for that tool — no cross-tool envelope
 * for the model to second-guess.
 */
export const wireTagFor = (tool: AssistantTool): string => {
  switch (tool) {
    case CLAUDE_CODE:
      return 'claude-md';
    case 'copilot':
      return 'copilot-instructions';
    case 'codex':
      return 'agents-md';
  }
};

/**
 * Map an {@link AssistantTool} to the partial name that holds its target-file conventions.
 * The partial is loaded by `buildReadinessPrompt` and passed as `targetFileConventions` so
 * the AI receives per-provider style guidance before it sees the output contract shape.
 */
export const conventionsPartialName = (
  tool: AssistantTool
): 'conventions-claude-md' | 'conventions-copilot-instructions' | 'conventions-agents-md' => {
  switch (tool) {
    case CLAUDE_CODE:
      return 'conventions-claude-md';
    case 'copilot':
      return 'conventions-copilot-instructions';
    case 'codex':
      return 'conventions-agents-md';
  }
};

/**
 * Readiness prompt definition.
 *
 * Partial choice: only `harness-context` is wired. There is no `signals-readiness` partial in
 * the v2 templates yet; the readiness template carries its own minimal output contract inline
 * (just `<{wireTag}>` + an optional `<note>`). Introducing a new partial would have widened
 * the scope of P10 (creating a partial + a P-spec for it). Decision logged in
 * `docs/architecture/packages/P10-readiness-chain.md`.
 *
 * Expected signals: `agents-md-proposal` (the proposed body — internal signal name kept stable
 * across tools) and `note` (optional commentary). The chain leaf parses the tool-specific
 * wire tag from the raw body — see `proposeReadinessLeaf`.
 */
export const readinessPromptDef: PromptDefinition<ReadinessPromptParams> = {
  templateName: 'readiness',
  description:
    'One-shot read-only repo inventory. The AI proposes a project context file body the harness writes to the tool-native target path.',
  parameters: {
    repositoryPath: {
      placeholder: 'REPOSITORY_PATH',
      description: 'Absolute path to the repository the AI is inventorying.',
      validate: (v: string) =>
        v.trim().length === 0
          ? Result.error(
              new ValidationError({
                field: 'repositoryPath',
                value: v,
                message: 'repository path must not be empty',
              })
            )
          : Result.ok(v),
    },
    currentTool: {
      placeholder: 'CURRENT_TOOL',
      description: 'The AssistantTool the harness is targeting (claude-code / copilot / codex).',
    },
    wireTag: {
      placeholder: 'WIRE_TAG',
      description: 'Tool-specific XML tag the AI should emit around its proposed body.',
    },
    existingContextFile: {
      placeholder: 'EXISTING_CONTEXT_FILE',
      description: 'Existing context-file body wrapped for prompting, or an explicit "no existing file" line.',
    },
    detectedArtefacts: {
      placeholder: 'DETECTED_ARTEFACTS',
      description: 'Bullet list of artefact paths discovered by the probe, or "no artefacts detected".',
    },
    targetFileConventions: {
      placeholder: 'TARGET_FILE_CONVENTIONS',
      description:
        'Per-provider style guide for the target context file (CLAUDE.md / .github/copilot-instructions.md / AGENTS.md). Loaded from the matching conventions partial.',
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        'Audit-[09] output contract block rendered from the readiness contract — instructs the AI to write `signals.json` directly with the proposal signals.',
      validate: (v: string) =>
        v.trim().length === 0
          ? Result.error(
              new ValidationError({
                field: 'outputContractSection',
                value: v,
                message: 'output-contract section must not be empty',
              })
            )
          : Result.ok(v),
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  expectedSignals: ['agents-md-proposal', 'setup-skill-proposal', 'verify-skill-proposal', 'skill-suggestions', 'note'],
};

/** Render the `currentTool` parameter as the same string the AssistantTool variant carries. */
export const renderCurrentTool = (tool: AssistantTool): string => tool;

/**
 * Render the existing-context-file block. When a body was supplied, wrap it in
 * `<existing-context>...</existing-context>` so the AI sees a clear delimiter. When absent,
 * surface a single explicit line — the prompt's "preserve verbatim" rule keys off whether a
 * body is present.
 */
export const renderExistingContextFile = (body: string | undefined): string => {
  if (body === undefined || body.trim().length === 0) {
    return '_(no existing context file present — emit a fresh body)_';
  }
  return `<existing-context>\n\n${body.trim()}\n\n</existing-context>`;
};

/**
 * Render detected artefacts as a markdown bullet list. Empty list → an explicit "no artefacts
 * detected" line so the prompt body never collapses into an empty placeholder.
 */
export const renderDetectedArtefacts = (paths: readonly string[]): string => {
  if (paths.length === 0) return '_(no artefacts detected by the probe)_';
  return paths.map((p) => `- \`${p}\``).join('\n');
};

/**
 * Pull the artefact paths off an {@link ReadinessState} for the prompt's detected-artefacts
 * block. `unknown` / `absent` → empty list. `present` → every `ArtifactRef.path` and every
 * `NamedArtifactRef.path` collected across the tool-specific catalog.
 */
export const collectArtefactPaths = (state: ReadinessState): readonly string[] => {
  if (!isPresent(state)) return [];
  const a = state.artifacts;
  const paths: string[] = [];
  if (a.tool === CLAUDE_CODE) {
    if (a.claudeMd !== undefined) paths.push(String(a.claudeMd.path));
    if (a.agentsMd !== undefined) paths.push(String(a.agentsMd.path));
    if (a.settings !== undefined) paths.push(String(a.settings.path));
    if (a.settingsLocal !== undefined) paths.push(String(a.settingsLocal.path));
    if (a.mcpConfig !== undefined) paths.push(String(a.mcpConfig.path));
    for (const ref of a.skills) paths.push(String(ref.path));
    for (const ref of a.commands) paths.push(String(ref.path));
    for (const ref of a.agents) paths.push(String(ref.path));
  } else if (a.tool === 'copilot' && a.copilotInstructions !== undefined) {
    paths.push(String(a.copilotInstructions.path));
  }
  // Codex artefacts placeholder — see ai/readiness/codex/artifacts.ts. No fields to walk yet.
  return paths;
};

export interface BuildReadinessPromptInput {
  readonly repositoryPath: string;
  readonly currentTool: AssistantTool;
  readonly probedState: ReadinessState;
  /** Existing context file body, when present. Supplied by the chain leaf when probe → present. */
  readonly existingContextFile?: string;
  /**
   * Pre-rendered audit-[09] output contract section. The leaf composes this via
   * `renderContractSectionFor(readinessOutputContract)` before calling the builder.
   */
  readonly outputContractSection: string;
}

/**
 * Top-level builder — accepts domain types, renders the param strings, calls `buildPrompt`.
 * The chain leaf consumes this via function injection.
 *
 * Loads the per-provider conventions partial manually (rather than via `partials` auto-load)
 * so the partial name can be computed dynamically from `currentTool` at call time. The loaded
 * body is passed as `targetFileConventions` — a regular string parameter — which the template
 * embeds inside `<target_file_conventions>` before the output contract section.
 */
export const buildReadinessPrompt = async (
  deps: TemplateLoader,
  input: BuildReadinessPromptInput
): Promise<Result<Prompt, BuildPromptError>> => {
  const partialName = conventionsPartialName(input.currentTool);
  const conventionsResult = await deps.load(partialName);
  if (!conventionsResult.ok) return Result.error(conventionsResult.error);

  return buildPrompt(deps, readinessPromptDef, {
    repositoryPath: input.repositoryPath,
    currentTool: renderCurrentTool(input.currentTool),
    wireTag: wireTagFor(input.currentTool),
    existingContextFile: renderExistingContextFile(input.existingContextFile),
    detectedArtefacts: renderDetectedArtefacts(collectArtefactPaths(input.probedState)),
    targetFileConventions: conventionsResult.value.trim(),
    outputContractSection: input.outputContractSection,
  });
};
