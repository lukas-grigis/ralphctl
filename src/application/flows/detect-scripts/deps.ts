import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Narrow dependency contract for the detect-scripts chain. The composition root constructs
 * each field from the integration layer and passes the bag to {@link createDetectScriptsFlow}.
 *
 *  - `projectRepo` — load + save the project (the chain persists the accepted scripts onto the
 *    repository inside the project aggregate).
 *  - `provider` / `templateLoader` / `signals` / `logger` — the standard AI-call quartet.
 *  - `interactive` — port for the pick-repository + confirm leaves.
 *  - `eventBus` — wired by the launcher; reserved for future per-leaf events.
 */
export interface DetectScriptsDeps {
  readonly projectRepo: ProjectRepository;
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly interactive: InteractivePrompt;
}
