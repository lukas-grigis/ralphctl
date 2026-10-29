/** Shared payload threaded into every per-flow `launchXxx` function. */

import type { Runner } from '@src/application/chain/run/runner.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { LauncherDeps, LaunchExtras } from '@src/application/ui/shared/launcher.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';

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
  readonly bridge: <T>(runner: Runner<T>) => Runner<unknown>;
  /**
   * Effort resolved via `resolveEffort(flowId, settings)` — undefined when the flow doesn't open an AI session.
   */
  readonly effort?: string;
}

/** The wiring every per-launch `createAiProvider` call shares, including the wire-time spawn seam. */
export const providerBaseArgs = (app: AppDeps, settings: Pick<Settings, 'harness'>) => ({
  harnessConfig: settings.harness,
  eventBus: app.eventBus,
  childRegistry: app.childRegistry,
  ...(app.providerSpawn !== undefined ? { spawn: app.providerSpawn } : {}),
});
