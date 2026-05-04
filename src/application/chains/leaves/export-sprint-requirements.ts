/**
 * `exportSprintRequirementsLeaf` — write the canonical sprint-level
 * requirements aggregate to `<sprintDir>/requirements.json`.
 *
 * The aggregate is **always re-derived** from the in-context `Sprint`
 * entity — only tickets with `requirementStatus === 'approved'` appear,
 * and the file is overwritten on every run. This guarantees the file
 * cannot drift from `sprint.json`: there is no separate persistence
 * step that could be partially applied.
 *
 * Wired into the refine flow's per-ticket sub-chain after `save-after-<id>`
 * so every approval rewrites the aggregate. Plan flow consumes the file
 * via `buildPlanningFolder` (copies it into `planning/requirements.json`).
 *
 * Pre-requirement: `ctx.sprint` is the freshly-saved sprint aggregate.
 */
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { WriteContextFilePort } from '@src/business/ports/write-context-file-port.ts';
import {
  buildSprintRequirementsAggregate,
  serialiseSprintRequirementsAggregate,
} from '@src/business/usecases/sprint/sprint-requirements-aggregate.ts';
import { resolveStoragePaths } from '@src/integration/persistence/storage-paths.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';

export interface ExportSprintRequirementsCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint;
}

export interface ExportSprintRequirementsLeafDeps {
  readonly writeContextFile: WriteContextFilePort;
}

export function exportSprintRequirementsLeaf<TCtx extends ExportSprintRequirementsCtx>(
  deps: ExportSprintRequirementsLeafDeps,
  name = 'export-sprint-requirements'
): Element<TCtx> {
  return new Leaf<TCtx, { readonly sprint: Sprint; readonly sprintId: SprintId }, void>(name, {
    useCase: {
      async execute(input): Promise<Result<void, DomainError>> {
        const aggregate = buildSprintRequirementsAggregate(input.sprint);
        const body = serialiseSprintRequirementsAggregate(aggregate);
        const target = resolveStoragePaths().requirementsAggregateFile(input.sprintId);
        return deps.writeContextFile.write(target, body);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) {
        throw new Error(`${name}: ctx.sprint must be set before this leaf`);
      }
      return { sprint: ctx.sprint, sprintId: ctx.sprintId };
    },
    output: (ctx) => ctx,
  });
}
