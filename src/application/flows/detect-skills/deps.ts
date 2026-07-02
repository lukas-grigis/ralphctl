import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';

/**
 * Narrow dependency contract for the detect-skills chain. Identical shape to
 * {@link DetectScriptsDeps} plus the {@link SkillsAdapter} — propose needs it to splice
 * the provider's skills-discovery convention into the authoring prompt so the AI knows
 * where to look for existing skills before drafting new ones.
 *
 *  - `runsRoot` — `<dataRoot>/runs`; the chain's `allocate-run-dir-detect-skills` leaf
 *    materialises `<runsRoot>/detect-skills/<run-id>/` before propose runs, so `prompt.md` +
 *    `body.txt` land there and empty / surprising proposals are forensically diagnosable.
 *    Confirm reads `body.txt` to show the AI's actual response inline.
 */
export interface DetectSkillsDeps {
  readonly projectRepo: ProjectRepository;
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly eventBus: EventBus;
  /** Atomic writer used to render the contract sidecars (`setup-skill.md` / `verify-skill.md`). */
  readonly writeFile: WriteFile;
  readonly logger: Logger;
  readonly interactive: InteractivePrompt;
  readonly skillsAdapter: SkillsAdapter;
  readonly runsRoot: AbsolutePath;
}
