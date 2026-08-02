import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type {
  LeafInput,
  PreTaskVerifyLeafDeps,
  PreTaskVerifyLeafOpts,
} from '@src/application/flows/implement/leaves/pre-task-verify.ts';

/** Fallback `WriteFile` for callers that don't (yet) wire the port — same atomic adapter either way. */
export const defaultWriteFile: WriteFile = (path, content) => writeTextAtomic(String(path), content);

/**
 * Audit [01] / [03]: persist the full untruncated verify output to
 * `<sprintDir>/logs/verify/<task-id>/pre-attempt-<N>.log`. Best-effort — write failures log warn
 * and never abort the chain.
 */
export const persistPreVerifyLog = async (
  deps: PreTaskVerifyLeafDeps,
  opts: PreTaskVerifyLeafOpts,
  input: LeafInput,
  rawOutput: string
): Promise<void> => {
  if (opts.sprintDir === undefined || rawOutput.length === 0) return;
  const attemptN = input.task.attempts.length;
  const logPath = join(
    String(opts.sprintDir),
    'logs',
    'verify',
    String(input.task.id),
    `pre-attempt-${String(attemptN)}.log`
  );
  const parsedPath = AbsolutePath.parse(logPath);
  if (!parsedPath.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `pre-task-verify ${String(opts.cwd)}: could not resolve log path ${logPath} — ${parsedPath.error.message}`,
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
      message: `pre-task-verify ${String(opts.cwd)}: failed to persist full log to ${logPath} — ${wrote.error.message}`,
      at: deps.clock(),
    });
  }
};
