import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { runCli } from '@src/integration/io/run-cli.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';

/**
 * Shared GitLab issue-notes reader for the issue fetcher (refine context) and the issue pusher
 * (idempotent refinement comments).
 *
 * glab has no note-listing subcommand (`glab issue note` only posts), so this reads the REST
 * notes endpoint via `glab api`. `--paginate` walks every page and, with `--output json`, glab
 * merges the pages into one JSON array — callers see every note, not just the first 100. The
 * project path is URL-encoded (subgroups included) as the API requires, and `--hostname` keeps a
 * self-hosted issue off gitlab.com.
 *
 * System notes (label changes, assignments, …) are dropped; the rest are sorted oldest-first by
 * `created_at` (defensive — the API's `sort=asc` already asks for that order).
 */

const CLI_TIMEOUT_MS = 30_000;
const UNKNOWN_ERROR = 'unknown error';
const NOTES_LABEL = 'glab api issue notes';

export interface GitLabIssueRef {
  readonly hostname: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface GitLabNote {
  readonly body: string;
  readonly author: string | undefined;
}

interface GlabNote {
  readonly body?: string;
  readonly author?: { readonly username?: string };
  readonly system?: boolean;
  readonly created_at?: string;
}

/** The `glab api` argv for an issue's notes. */
const gitLabNotesArgs = (ref: GitLabIssueRef): readonly string[] => [
  'api',
  '--hostname',
  ref.hostname,
  '--paginate',
  '--output',
  'json',
  `projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}/issues/${String(ref.number)}/notes?per_page=100&sort=asc&order_by=created_at`,
];

export const listGitLabIssueNotes = async (
  spawn: Spawn,
  ref: GitLabIssueRef
): Promise<Result<readonly GitLabNote[], StorageError>> => {
  const result = await runCli(spawn, 'glab', [...gitLabNotesArgs(ref)], { timeoutMs: CLI_TIMEOUT_MS });
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `${NOTES_LABEL} failed: ${result.value.stderr.trim() || UNKNOWN_ERROR}`,
      })
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.value.stdout);
  } catch (cause) {
    return Result.error(
      new StorageError({ subCode: 'parse', message: `failed to parse ${NOTES_LABEL} response`, cause })
    );
  }
  if (!Array.isArray(parsed)) {
    return Result.error(
      new StorageError({ subCode: 'parse', message: `failed to parse ${NOTES_LABEL} response: expected a JSON array` })
    );
  }
  // Every field is optional on `GlabNote`; the `??` defaults below tolerate missing ones.
  const notes = (parsed as readonly GlabNote[]).filter((n) => n.system !== true);
  const sorted = [...notes].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  return Result.ok(sorted.map((n) => ({ body: n.body ?? '', author: n.author?.username })));
};
