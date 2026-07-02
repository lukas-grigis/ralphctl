import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
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
 *  - `provider` / `templateLoader` / `logger` — the standard AI-call trio.
 *  - `interactive` — port for the pick-repository + confirm leaves.
 *  - `eventBus` — the flow factory binds a `publishSignal` off it (`source: 'detect-scripts'`)
 *    for the propose leaf; also reserved for future per-leaf events.
 *  - `runsRoot` — `<dataRoot>/runs`; the chain's `allocate-run-dir-detect-scripts` leaf
 *    materialises `<runsRoot>/detect-scripts/<run-id>/` before propose runs, so `prompt.md` +
 *    `body.txt` land there and an empty or surprising proposal is forensically diagnosable
 *    after the chain exits.
 */
export interface DetectScriptsDeps {
  readonly projectRepo: ProjectRepository;
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly interactive: InteractivePrompt;
  readonly runsRoot: AbsolutePath;
}
