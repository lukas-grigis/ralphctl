import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

export interface CreatePrInput {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly base: string;
  readonly draft: boolean;
  /** Pre-loaded tasks to feed the body deriver. Empty omits the `## Tasks` section. */
  readonly tasks?: readonly Task[];
  /** Override for derived title. */
  readonly title?: string;
  /** Override for derived body. */
  readonly body?: string;
}

export interface CreatePrOutput {
  readonly url: string;
}

export interface CreatePrCtx {
  readonly input: CreatePrInput;
  readonly output?: CreatePrOutput;
}
