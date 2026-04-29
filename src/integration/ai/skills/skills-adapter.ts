import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { LinkedSkillSet, ResolvedSkill, SkillPhase, SkillsPort } from '@src/business/ports/skills.ts';
import { loadSkillsForPhase } from './loader.ts';
import { cleanupSkills, linkSkillsForPhase } from './lifecycle.ts';

/**
 * Default `SkillsPort` adapter. Wraps the pure loader + lifecycle modules
 * with the harness's `LoggerPort` so invalid skills and link failures land
 * in the same structured log stream as the rest of pipeline output.
 *
 * The adapter is stateless — each method is a thin call into the underlying
 * pure functions. State (the module-level registry of active linked sets)
 * lives in `lifecycle.ts` so a `process.on('exit')` handler can reap leftover
 * symlinks even if the adapter is garbage-collected first.
 */
export class DefaultSkillsAdapter implements SkillsPort {
  constructor(private readonly logger: LoggerPort) {}

  async loadForPhase(phase: SkillPhase): Promise<ResolvedSkill[]> {
    return await loadSkillsForPhase(phase, { logger: this.logger });
  }

  async link(workingDir: string, skills: readonly ResolvedSkill[]): Promise<LinkedSkillSet> {
    return await linkSkillsForPhase(workingDir, skills, this.logger);
  }

  async cleanup(set: LinkedSkillSet): Promise<void> {
    await cleanupSkills(set, this.logger);
  }
}
