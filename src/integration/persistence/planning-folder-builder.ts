/**
 * `buildPlanningFolder` — materialise the single per-sprint planning sandbox.
 *
 * Layout: `<sprintDir>/planning/`
 *   - `CLAUDE.md` or `.github/copilot-instructions.md` (context file)
 *   - `requirements.json` — real copy of `<sprintDir>/requirements.json`
 *     (falls back to inline derivation if the canonical file is missing)
 *   - `session.md` — written by `ProviderAiSessionAdapter` at spawn time
 *   - `tasks.json` — where the AI writes its raw output
 *   - `repos/<basename>/` — Copilot-only mirror of each affected repo
 *   - `.claude/skills/` — managed separately by `link-skills` / `unlink-skills`
 */
import { basename, join } from 'node:path';

import type { AiProvider } from '@src/business/ports/ai-session-port.ts';
import type { PlanningFolderPaths } from '@src/business/ports/session-folder-builder-port.ts';
import {
  buildSprintRequirementsAggregate,
  serialiseSprintRequirementsAggregate,
} from '@src/business/usecases/sprint/sprint-requirements-aggregate.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { StoragePaths } from '@src/integration/persistence/storage-paths.ts';
import {
  copyFileSafe,
  ensureDirSafe,
  mirrorRepo,
  writeContextFile,
  writeFileSafe,
} from '@src/integration/persistence/session-folder-helpers.ts';

export async function buildPlanningFolder(
  storage: StoragePaths,
  input: {
    readonly sprint: Sprint;
    readonly aiProvider: AiProvider;
  }
): Promise<Result<PlanningFolderPaths, DomainError>> {
  const root = storage.planningDir(input.sprint.id);
  const ensure = await ensureDirSafe(root);
  if (!ensure.ok) return Result.error(ensure.error);

  const isCopilot = input.aiProvider === 'copilot';

  const ctx = await writeContextFile({
    root,
    sprint: input.sprint,
    provider: input.aiProvider,
    phase: 'plan',
    affectedRepos: input.sprint.affectedRepositories,
  });
  if (!ctx.ok) return Result.error(ctx.error);

  // Stage the canonical sprint requirements aggregate inside the
  // planning sandbox as a real copy (not a symlink) so the prompt /
  // session is reproducible from the folder alone — re-running plan
  // off an archived sprint dir picks up exactly the requirements the
  // AI saw. The aggregate is auto-maintained by the refine flow's
  // `export-sprint-requirements` leaf; for legacy sprints (or any
  // path where the canonical file is missing) we fall back to
  // deriving the aggregate inline from the in-context sprint so plan
  // never fails over a missing-but-recoverable file.
  const reqSrc = String(storage.requirementsAggregateFile(input.sprint.id));
  const reqDst = join(root, 'requirements.json');
  const copied = await copyFileSafe(reqSrc, reqDst);
  if (!copied.ok) {
    const inlineBody = serialiseSprintRequirementsAggregate(buildSprintRequirementsAggregate(input.sprint));
    const wrote = await writeFileSafe(reqDst, inlineBody);
    if (!wrote.ok) return Result.error(wrote.error);
  }

  let addDirs: readonly AbsolutePath[];
  if (isCopilot) {
    const reposDir = join(root, 'repos');
    const ensureRepos = await ensureDirSafe(reposDir);
    if (!ensureRepos.ok) return Result.error(ensureRepos.error);
    for (const repoPath of input.sprint.affectedRepositories) {
      const dst = join(reposDir, basename(repoPath));
      const m = await mirrorRepo(repoPath, dst);
      if (!m.ok) return Result.error(m.error);
    }
    addDirs = [];
  } else {
    addDirs = [...input.sprint.affectedRepositories];
  }

  return Result.ok({
    root,
    sessionMdPath: AbsolutePath.trustString(join(root, 'session.md')),
    rawTasksJsonPath: AbsolutePath.trustString(join(root, 'tasks.json')),
    addDirs,
  });
}
