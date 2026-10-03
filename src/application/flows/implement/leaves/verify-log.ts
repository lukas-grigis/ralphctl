import { join } from 'node:path';
import type { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';

type VerifyPhase = 'pre' | 'post';

const defaultWriteFile: WriteFile = (path, content) => writeTextAtomic(String(path), content);

const verifyLogPathString = (sprintDir: AbsolutePath, taskId: TaskId, phase: VerifyPhase, attemptN: number): string =>
  join(String(sprintDir), 'logs', 'verify', String(taskId), `${phase}-attempt-${String(attemptN)}.log`);

/** The one place the `<sprintDir>/logs/verify/<task-id>/<phase>-attempt-<N>.log` layout lives — writer and reader share it. */
export const verifyLogPath = (
  sprintDir: AbsolutePath,
  taskId: TaskId,
  phase: VerifyPhase,
  attemptN: number
): Result<AbsolutePath, ValidationError> => AbsolutePath.parse(verifyLogPathString(sprintDir, taskId, phase, attemptN));

/** Best-effort persist of the full untruncated verify output (audit [01] / [03]) — failures warn, never abort the chain. */
export const persistVerifyLog = async (
  deps: { readonly eventBus: EventBus; readonly clock: () => IsoTimestamp; readonly writeFile?: WriteFile },
  phase: VerifyPhase,
  cwd: AbsolutePath,
  sprintDir: AbsolutePath | undefined,
  task: InProgressTask,
  rawOutput: string
): Promise<void> => {
  if (sprintDir === undefined || rawOutput.length === 0) return;
  const logPath = verifyLogPathString(sprintDir, task.id, phase, task.attempts.length);
  const prefix = `${phase}-task-verify ${String(cwd)}`;
  const parsedPath = AbsolutePath.parse(logPath);
  if (!parsedPath.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `${prefix}: could not resolve log path ${logPath} — ${parsedPath.error.message}`,
      at: deps.clock(),
    });
    return;
  }
  const writeFile = deps.writeFile ?? defaultWriteFile;
  const wrote = await writeFile(parsedPath.value, rawOutput);
  if (!wrote.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `${prefix}: failed to persist full log to ${logPath} — ${wrote.error.message}`,
      at: deps.clock(),
    });
  }
};
