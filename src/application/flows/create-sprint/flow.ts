import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadProjectLeaf } from '@src/application/flows/_shared/project/load.ts';
import { saveSprintLeaf } from '@src/application/flows/_shared/sprint/save.ts';
import { saveSprintExecutionLeaf } from '@src/application/flows/_shared/sprint/save-execution.ts';
import type { CreateSprintCtx } from '@src/application/flows/create-sprint/ctx.ts';
import type { CreateSprintDeps } from '@src/application/flows/create-sprint/deps.ts';
import { createSprintLeaf } from '@src/application/flows/create-sprint/leaves/create-sprint.ts';
import { interactiveSprintNameLeaf } from '@src/application/flows/create-sprint/leaves/interactive-sprint-name.ts';

/**
 * Build the create-sprint chain.
 *
 * Shape:
 *
 *   sequential('create-sprint', [
 *     load-project,
 *     interactive-sprint-name,
 *     create-sprint,
 *     save-sprint,
 *     save-sprint-execution,
 *   ])
 *
 * No retries: every step here is fast, deterministic, and either user-driven or pure. The two
 * persistence steps run sequentially — sprint first, then execution — so a crash between them
 * leaves a sprint without its paired execution. That's the same trade-off other chains make:
 * the next launch can rerun create-sprint and overwrite cleanly because nothing else holds
 * references yet.
 */
export const createCreateSprintFlow = (deps: CreateSprintDeps): Element<CreateSprintCtx> =>
  sequential<CreateSprintCtx>('create-sprint', [
    loadProjectLeaf<CreateSprintCtx>({ projectRepo: deps.projectRepo }),
    interactiveSprintNameLeaf({ interactive: deps.interactive }),
    createSprintLeaf({ logger: deps.logger }),
    saveSprintLeaf<CreateSprintCtx>({ sprintRepo: deps.sprintRepo }),
    saveSprintExecutionLeaf<CreateSprintCtx>({ sprintExecutionRepo: deps.sprintExecutionRepo }),
  ]);
