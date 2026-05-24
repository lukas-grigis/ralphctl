import { z } from 'zod';
import type { AgentsMdProposalSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `agents-md-proposal` AI signal — readiness-flow body that becomes the
 * provider-native context file (`CLAUDE.md` / `.github/copilot-instructions.md` / `AGENTS.md`).
 * The `tag` discriminator records which wire tag the AI emitted so the harness can verify
 * the AI used the tool-specific tag matching the readiness row's provider
 * (`settings.ai.readiness.provider`).
 */
/** @public */
export const agentsMdProposalSignalSchema = z.object({
  type: z.literal('agents-md-proposal'),
  tag: z.union([z.literal('claude-md'), z.literal('copilot-instructions'), z.literal('agents-md')]),
  content: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof agentsMdProposalSignalSchema>, AgentsMdProposalSignal> = true;
void _typeCheck;
