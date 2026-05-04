/**
 * `WriteContextFilePort` — narrow filesystem seam for writing per-task
 * context markdown.
 *
 * The per-task chain renders a rich markdown context file under
 * `<sprintDir>/contexts/<task-id>.md` containing everything the AI
 * generator needs to implement the task: name, description, steps,
 * verification criteria, branch, check script, environment status,
 * and a pointer to the running progress log.
 *
 * The file lives outside the user's repo (under `~/.ralphctl/data/...`),
 * so it never gets committed and the prompt template can reference it by
 * absolute path. Writing is the only filesystem operation the use case
 * needs — keeping the port narrow (one method) avoids introducing a
 * grab-bag `FileSystemPort` while still letting tests inject a fake.
 */
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

export interface WriteContextFilePort {
  /**
   * Write `content` to `path`, creating any missing parent directories.
   * Overwrites any prior file at the same path — the harness owns the
   * file's lifecycle so re-running a task just replaces the prior body.
   *
   * Returns `Result.ok()` on success or a `StorageError` carrying the
   * underlying `cause`. The error must NOT be swallowed by callers — the
   * AI session is useless without the context file.
   */
  write(path: AbsolutePath, content: string): Promise<Result<void, StorageError>>;
}
