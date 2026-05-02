import { basename } from 'node:path';
import { Result } from 'typescript-result';

import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ValidationError } from '@src/domain/values/validation-error.ts';

/** Construction inputs for {@link Repository.create}. */
export interface RepositoryCreateInput {
  readonly path: AbsolutePath;
  readonly name?: string;
  readonly checkScript?: string;
  readonly checkTimeout?: number;
  readonly setupScript?: string;
  readonly onboardedAt?: IsoTimestamp;
}

/**
 * `Repository` — nested entity within a `Project`. The `path` is the
 * primary identity; `name` defaults to `basename(path)` when omitted.
 *
 * Optional fields:
 *  - `checkScript` — the post-task gate command for this repo (e.g.
 *    `pnpm typecheck && pnpm lint && pnpm test`).
 *  - `checkTimeout` — per-repo override (ms) for `RALPHCTL_SETUP_TIMEOUT_MS`.
 *  - `setupScript` — one-shot prepare command (e.g. `pnpm install`) the
 *    harness can run before agentic work. Distinct from `checkScript`,
 *    which is the post-task verification gate.
 *  - `onboardedAt` — set by the onboard chain on a successful run; powers
 *    the "is this repo onboarded yet?" status surface in TUI / CLI / doctor.
 *    Overwriting from a subsequent run is fine — the most recent timestamp
 *    is the one that matters.
 *
 * Returned new instances on every mutation; never mutates `this`.
 */
export class Repository {
  readonly name: string;
  readonly path: AbsolutePath;
  readonly checkScript: string | undefined;
  readonly checkTimeout: number | undefined;
  readonly setupScript: string | undefined;
  readonly onboardedAt: IsoTimestamp | null;

  private constructor(props: {
    name: string;
    path: AbsolutePath;
    checkScript: string | undefined;
    checkTimeout: number | undefined;
    setupScript: string | undefined;
    onboardedAt: IsoTimestamp | null;
  }) {
    this.name = props.name;
    this.path = props.path;
    this.checkScript = props.checkScript;
    this.checkTimeout = props.checkTimeout;
    this.setupScript = props.setupScript;
    this.onboardedAt = props.onboardedAt;
  }

  static create(input: RepositoryCreateInput): Result<Repository, ValidationError> {
    const nameResult = resolveName(input.name, input.path);
    if (!nameResult.ok) return Result.error(nameResult.error);

    const checkScript = normaliseScript(input.checkScript, 'repository.checkScript');
    if (!checkScript.ok) return Result.error(checkScript.error);

    const checkTimeout = normaliseCheckTimeout(input.checkTimeout);
    if (!checkTimeout.ok) return Result.error(checkTimeout.error);

    const setupScript = normaliseScript(input.setupScript, 'repository.setupScript');
    if (!setupScript.ok) return Result.error(setupScript.error);

    return Result.ok(
      new Repository({
        name: nameResult.value,
        path: input.path,
        checkScript: checkScript.value,
        checkTimeout: checkTimeout.value,
        setupScript: setupScript.value,
        onboardedAt: input.onboardedAt ?? null,
      })
    );
  }

  withCheckScript(script: string | undefined): Result<Repository, ValidationError> {
    const next = normaliseScript(script, 'repository.checkScript');
    if (!next.ok) return Result.error(next.error);
    return Result.ok(
      new Repository({
        name: this.name,
        path: this.path,
        checkScript: next.value,
        checkTimeout: this.checkTimeout,
        setupScript: this.setupScript,
        onboardedAt: this.onboardedAt,
      })
    );
  }

  withCheckTimeout(ms: number | undefined): Result<Repository, ValidationError> {
    const next = normaliseCheckTimeout(ms);
    if (!next.ok) return Result.error(next.error);
    return Result.ok(
      new Repository({
        name: this.name,
        path: this.path,
        checkScript: this.checkScript,
        checkTimeout: next.value,
        setupScript: this.setupScript,
        onboardedAt: this.onboardedAt,
      })
    );
  }

  withSetupScript(script: string | undefined): Result<Repository, ValidationError> {
    const next = normaliseScript(script, 'repository.setupScript');
    if (!next.ok) return Result.error(next.error);
    return Result.ok(
      new Repository({
        name: this.name,
        path: this.path,
        checkScript: this.checkScript,
        checkTimeout: this.checkTimeout,
        setupScript: next.value,
        onboardedAt: this.onboardedAt,
      })
    );
  }

  /**
   * Stamp the repository as onboarded at `now`. Pure update — returns a
   * new instance. No state guard: re-running onboarding overwrites the
   * timestamp, which is the desired semantics (most-recent run wins).
   */
  markOnboarded(now: IsoTimestamp): Repository {
    return new Repository({
      name: this.name,
      path: this.path,
      checkScript: this.checkScript,
      checkTimeout: this.checkTimeout,
      setupScript: this.setupScript,
      onboardedAt: now,
    });
  }

  /** Clear the onboarded marker. */
  clearOnboarded(): Repository {
    return new Repository({
      name: this.name,
      path: this.path,
      checkScript: this.checkScript,
      checkTimeout: this.checkTimeout,
      setupScript: this.setupScript,
      onboardedAt: null,
    });
  }
}

function resolveName(candidate: string | undefined, path: AbsolutePath): Result<string, ValidationError> {
  if (candidate === undefined) {
    const fallback = basename(path);
    if (fallback.length === 0) {
      return Result.error(
        new ValidationError({
          field: 'repository.name',
          value: path,
          message: 'could not derive repository name from path',
          hint: 'pass an explicit name',
        })
      );
    }
    return Result.ok(fallback);
  }
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return Result.error(
      new ValidationError({
        field: 'repository.name',
        value: candidate,
        message: 'repository name must be non-empty when provided',
      })
    );
  }
  return Result.ok(trimmed);
}

function normaliseScript(candidate: string | undefined, field: string): Result<string | undefined, ValidationError> {
  if (candidate === undefined) return Result.ok(undefined);
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return Result.error(
      new ValidationError({
        field,
        value: candidate,
        message: `${field} must be non-empty when provided`,
        hint: 'omit the field instead of passing an empty string',
      })
    );
  }
  return Result.ok(trimmed);
}

function normaliseCheckTimeout(candidate: number | undefined): Result<number | undefined, ValidationError> {
  if (candidate === undefined) return Result.ok(undefined);
  if (!Number.isFinite(candidate) || !Number.isInteger(candidate) || candidate <= 0) {
    return Result.error(
      new ValidationError({
        field: 'repository.checkTimeout',
        value: candidate,
        message: 'checkTimeout must be a positive integer (ms)',
      })
    );
  }
  return Result.ok(candidate);
}
