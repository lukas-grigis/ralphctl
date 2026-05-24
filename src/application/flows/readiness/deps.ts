import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { ReadinessProbeRegistry } from '@src/integration/ai/readiness/_engine/probe.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';

/**
 * Narrow dependency contract for the readiness chain. Composition root constructs each
 * field from the integration layer and passes the bag to `createReadinessFlow`.
 *
 *  - `projectRepo` — load the project so the user can pick which repo to set up readiness for.
 *  - `probes` — registry of filesystem probes keyed by tool. Each per-tool sub-chain
 *    dispatches on its tool to discover existing artefacts before the AI call.
 *  - `providerFor` — per-provider headless AI adapter factory. The flow calls it once per
 *    unique provider referenced across `settings.ai`'s per-flow rows.
 *  - `skillsAdapterFor` — per-provider skills adapter factory. Each provider's
 *    `<parentDir>/skills/` convention differs (`.claude/skills/`, `.github/skills/`,
 *    `.agents/skills/`); the factory selects the matching adapter.
 *  - `templateLoader` / `logger` — standard AI-call trio (audit-[09]: the AI writes
 *    signals.json directly; no signal sink is needed on this layer).
 *  - `interactive` — port for the pick-repository step (the pick-tool step is gone — the
 *    tool set is derived from settings.ai).
 *  - `writeFile` — the {@link WriteFile} port used by the terminal write leaf.
 *  - `clock` — injected so tests pin the backup-file timestamp suffix to a fixed value.
 */
export interface SetupReadinessDeps {
  readonly projectRepo: ProjectRepository;
  readonly probes: ReadinessProbeRegistry;
  readonly providerFor: (provider: AiProvider) => HeadlessAiProvider;
  readonly skillsAdapterFor: (provider: AiProvider) => SkillsAdapter;
  readonly templateLoader: TemplateLoader;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly interactive: InteractivePrompt;
  readonly writeFile: WriteFile;
  readonly clock: () => IsoTimestamp;
  readonly skillSource: SkillSource;
  /** `<dataRoot>/runs`; threaded to the propose leaf + engine for forensic artifact persistence. */
  readonly runsRoot: AbsolutePath;
}
