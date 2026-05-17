/**
 * Shared payload threaded into every per-flow `launchXxx` function. The launcher resolves these
 * once per launch — fresh settings (post any Settings-view edit), provider-bound adapters
 * rebuilt from those settings, a composed skill source, and a runner→event-bus bridge factory.
 * Per-flow modules then read only what they need.
 */

import type { Runner } from '@src/application/chain/run/runner.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { LauncherDeps, LaunchExtras } from '@src/application/ui/shared/launcher.ts';

export interface LaunchContext {
  readonly deps: LauncherDeps;
  readonly snapshot: AppStateSnapshot;
  readonly extras: LaunchExtras;
  readonly settings: Settings;
  readonly provider: HeadlessAiProvider;
  readonly interactiveAi: InteractiveAiProvider;
  readonly skillsAdapter: SkillsAdapter;
  readonly skillSource: SkillSource;
  /** Pre-resolved repo path from `snapshot.project.repositories[0].path`, if any. */
  readonly cwd: AbsolutePath | undefined;
  readonly sessionId: () => string;
  /** Wires the runner to the event bus so subscribers see chain progress. */
  readonly bridge: <T>(runner: Runner<T>) => Runner<T>;
}
