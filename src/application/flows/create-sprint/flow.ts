import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadProjectLeaf } from '@src/application/flows/_shared/project/load.ts';
import { saveSprintLeaf } from '@src/application/flows/_shared/sprint/save.ts';
import { saveSprintExecutionLeaf } from '@src/application/flows/_shared/sprint/save-execution.ts';
import type { CreateSprintCtx } from '@src/application/flows/create-sprint/ctx.ts';
import type { CreateSprintDeps } from '@src/application/flows/create-sprint/deps.ts';
import { createSprintLeaf } from '@src/application/flows/create-sprint/leaves/create-sprint.ts';
import { interactiveSprintNameLeaf } from '@src/application/flows/create-sprint/leaves/interactive-sprint-name.ts';
import { initProgressJournalLeaf } from '@src/application/flows/create-sprint/leaves/init-progress-journal.ts';

/**
 * Create a draft sprint. Sprint then execution are saved in sequence, so a crash between them
 * leaves a sprint without its execution; re-running overwrites cleanly since nothing references
 * it yet.
 */
export const createCreateSprintFlow = (deps: CreateSprintDeps): Element<CreateSprintCtx> =>
  sequential<CreateSprintCtx>('create-sprint', [
    loadProjectLeaf<CreateSprintCtx>({ projectRepo: deps.projectRepo }),
    interactiveSprintNameLeaf({ interactive: deps.interactive }),
    createSprintLeaf({ logger: deps.logger }),
    saveSprintLeaf<CreateSprintCtx>({ sprintRepo: deps.sprintRepo }),
    saveSprintExecutionLeaf<CreateSprintCtx>({ sprintExecutionRepo: deps.sprintExecutionRepo }),
    // Write the sprint header into `<sprintDir>/progress.md`. The journal grows append-only
    // from here; the implement chain appends per-attempt sections and status separators.
    initProgressJournalLeaf(
      { appendFile: deps.appendFile, clock: deps.clock, logger: deps.logger },
      { dataRoot: deps.dataRoot }
    ),
  ]);
