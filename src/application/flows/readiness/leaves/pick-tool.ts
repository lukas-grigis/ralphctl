import type { Result } from '@src/domain/result.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { ASSISTANT_TOOLS, type AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';

export interface PickToolLeafDeps {
  readonly interactive: InteractivePrompt;
}

const TOOL_LABELS: Readonly<Record<AssistantTool, string>> = {
  'claude-code': 'Claude Code (CLAUDE.md)',
  copilot: 'GitHub Copilot (.github/copilot-instructions.md)',
  codex: 'OpenAI Codex (AGENTS.md)',
};

/**
 * Interactive leaf — let the user pick which {@link AssistantTool} the readiness artefact
 * targets. The label rendered next to each option states the canonical filename so the user
 * can see at-a-glance where the harness will write.
 *
 * The choice list is built from {@link ASSISTANT_TOOLS} so adding a tool variant flows here
 * automatically — every member of the union appears in the menu.
 */
const pickToolUseCase = async (deps: PickToolLeafDeps): Promise<Result<AssistantTool, DomainError>> => {
  const choices: ReadonlyArray<Choice<AssistantTool>> = ASSISTANT_TOOLS.map((tool) => ({
    label: TOOL_LABELS[tool],
    value: tool,
  }));

  return deps.interactive.askChoice('Which tool are you setting up readiness for?', choices);
};

export const pickToolLeaf = (deps: PickToolLeafDeps): Element<ReadinessCtx> =>
  leaf<ReadinessCtx, Record<string, never>, AssistantTool>('pick-tool', {
    useCase: {
      execute: async () => pickToolUseCase(deps),
    },
    input: () => ({}),
    output: (ctx, tool) => ({ ...ctx, tool }),
  });
