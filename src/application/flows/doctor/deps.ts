import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import type { RunCommand } from '@src/integration/io/run-command.ts';

export interface DoctorDeps {
  readonly projectRepo: ProjectRepository;
  readonly sprintRepo: SprintRepository;
  readonly sprintExecutionRepo: SprintExecutionRepository;
  readonly settingsRepo: SettingsRepository;
  /**
   * Predicate that resolves whether a named executable is on `PATH`. Production passes the
   * `node:child_process`-backed implementation from `platform/shell/command-exists.ts`; tests
   * pass a stub keyed on binary name so the suite is deterministic regardless of what is
   * actually installed on the runner.
   */
  readonly commandExists: (name: string) => Promise<boolean>;
  /**
   * One-shot command runner used for "is this CLI authenticated?" probes, reading
   * `git config`, and resolving each project's default branch. Tests pass a stub keyed
   * on command + args.
   */
  readonly runCommand: RunCommand;
  /**
   * Current Node runtime version (e.g. `process.version` → `"v24.1.0"`). Injected so tests
   * can pin the value rather than dragging in `process` globals.
   */
  readonly nodeVersion: string;
}
