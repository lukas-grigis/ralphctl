import { basename } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';
import { parseOptionalString } from '@src/domain/value/parsers/parse-optional-string.ts';
import { parsePositiveInt } from '@src/domain/value/parsers/parse-positive-int.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * `id` is the stable domain identity (UUIDv7). `slug` is a kebab-case CLI handle (renamable
 * without breaking refs). `path` is a local-machine fact and may differ across environments —
 * never use it as identity. `name` is human-readable display, defaulted from `path` basename
 * when not supplied. Readiness state is no longer a Repository field — see
 * `ai/readiness/_engine/`.
 */
export interface Repository extends Entity<RepositoryId> {
  readonly slug: Slug;
  readonly name: string;
  readonly path: AbsolutePath;
  readonly checkScript?: string;
  readonly checkTimeout?: number;
  readonly setupScript?: string;
  /**
   * Markdown body of a per-repo *setup* skill: AI guidance the harness installs into every
   * AI session for this repo so the assistant knows how to prepare the working tree (build
   * tooling, monorepo layout, etc.). Distinct from {@link setupScript}, which is the literal
   * shell line. Authored by the user via the `detect-skills` flow (AI-proposed, human-approved).
   */
  readonly setupSkill?: string;
  /**
   * Markdown body of a per-repo *verify* skill: AI guidance for verifying changes (how the
   * project surfaces test/lint/typecheck signal, how to interpret failures). Distinct from
   * {@link checkScript}. Same authoring path as `setupSkill`.
   */
  readonly verifySkill?: string;
}

export interface RepositoryCreateInput {
  readonly id?: RepositoryId;
  readonly path: AbsolutePath;
  readonly name?: string;
  /** Optional. Defaults to `kebab-case(name)` (which itself defaults to `basename(path)`). */
  readonly slug?: Slug;
  readonly checkScript?: string;
  readonly checkTimeout?: number;
  readonly setupScript?: string;
  readonly setupSkill?: string;
  readonly verifySkill?: string;
}

export const createRepository = (input: RepositoryCreateInput): Result<Repository, ValidationError> => {
  const nameResult = resolveName(input.name, input.path);
  if (!nameResult.ok) return Result.error(nameResult.error);

  const slugResult = resolveSlug(input.slug, nameResult.value);
  if (!slugResult.ok) return Result.error(slugResult.error);

  const checkScript = parseOptionalString('repository.checkScript', input.checkScript);
  if (!checkScript.ok) return Result.error(checkScript.error);

  const setupScript = parseOptionalString('repository.setupScript', input.setupScript);
  if (!setupScript.ok) return Result.error(setupScript.error);

  const setupSkill = parseOptionalString('repository.setupSkill', input.setupSkill);
  if (!setupSkill.ok) return Result.error(setupSkill.error);

  const verifySkill = parseOptionalString('repository.verifySkill', input.verifySkill);
  if (!verifySkill.ok) return Result.error(verifySkill.error);

  let checkTimeout: number | undefined;
  if (input.checkTimeout !== undefined) {
    const parsed = parsePositiveInt('repository.checkTimeout', input.checkTimeout);
    if (!parsed.ok) return Result.error(parsed.error);
    checkTimeout = parsed.value;
  }

  return Result.ok({
    id: input.id ?? RepositoryId.generate(),
    slug: slugResult.value,
    name: nameResult.value,
    path: input.path,
    ...(checkScript.value !== undefined ? { checkScript: checkScript.value } : {}),
    ...(checkTimeout !== undefined ? { checkTimeout } : {}),
    ...(setupScript.value !== undefined ? { setupScript: setupScript.value } : {}),
    ...(setupSkill.value !== undefined ? { setupSkill: setupSkill.value } : {}),
    ...(verifySkill.value !== undefined ? { verifySkill: verifySkill.value } : {}),
  });
};

export const setRepositoryCheckScript = (
  repo: Repository,
  script: string | undefined
): Result<Repository, ValidationError> => {
  const next = parseOptionalString('repository.checkScript', script);
  if (!next.ok) return Result.error(next.error);
  if (next.value === undefined) {
    const { checkScript: _drop, ...rest } = repo;
    void _drop;
    return Result.ok(rest);
  }
  return Result.ok({ ...repo, checkScript: next.value });
};

export const setRepositoryCheckTimeout = (
  repo: Repository,
  ms: number | undefined
): Result<Repository, ValidationError> => {
  if (ms === undefined) {
    const { checkTimeout: _drop, ...rest } = repo;
    void _drop;
    return Result.ok(rest);
  }
  const next = parsePositiveInt('repository.checkTimeout', ms);
  if (!next.ok) return Result.error(next.error);
  return Result.ok({ ...repo, checkTimeout: next.value });
};

export const setRepositorySetupScript = (
  repo: Repository,
  script: string | undefined
): Result<Repository, ValidationError> => {
  const next = parseOptionalString('repository.setupScript', script);
  if (!next.ok) return Result.error(next.error);
  if (next.value === undefined) {
    const { setupScript: _drop, ...rest } = repo;
    void _drop;
    return Result.ok(rest);
  }
  return Result.ok({ ...repo, setupScript: next.value });
};

export const setRepositorySetupSkill = (
  repo: Repository,
  body: string | undefined
): Result<Repository, ValidationError> => {
  const next = parseOptionalString('repository.setupSkill', body);
  if (!next.ok) return Result.error(next.error);
  if (next.value === undefined) {
    const { setupSkill: _drop, ...rest } = repo;
    void _drop;
    return Result.ok(rest);
  }
  return Result.ok({ ...repo, setupSkill: next.value });
};

export const setRepositoryVerifySkill = (
  repo: Repository,
  body: string | undefined
): Result<Repository, ValidationError> => {
  const next = parseOptionalString('repository.verifySkill', body);
  if (!next.ok) return Result.error(next.error);
  if (next.value === undefined) {
    const { verifySkill: _drop, ...rest } = repo;
    void _drop;
    return Result.ok(rest);
  }
  return Result.ok({ ...repo, verifySkill: next.value });
};

/** Local path is a per-machine fact, not identity — change it freely without touching `id`. */
export const setRepositoryPath = (repo: Repository, path: AbsolutePath): Repository => ({
  ...repo,
  path,
});

export const setRepositoryName = (repo: Repository, name: string): Result<Repository, ValidationError> => {
  const parsed = parseRequiredString('repository.name', name);
  if (!parsed.ok) return Result.error(parsed.error);
  return Result.ok({ ...repo, name: parsed.value });
};

/** Slug rename. The owning project enforces project-scoped uniqueness — see {@link updateRepository}. */
export const setRepositorySlug = (repo: Repository, slug: Slug): Repository => ({
  ...repo,
  slug,
});

const resolveName = (candidate: string | undefined, path: AbsolutePath): Result<string, ValidationError> => {
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
  return parseRequiredString('repository.name', candidate);
};

const resolveSlug = (candidate: Slug | undefined, name: string): Result<Slug, ValidationError> => {
  if (candidate !== undefined) return Result.ok(candidate);
  const derived = toKebabCase(name);
  if (derived.length === 0) {
    return Result.error(
      new ValidationError({
        field: 'repository.slug',
        value: name,
        message: `could not derive slug from name '${name}'`,
        hint: 'pass an explicit slug',
      })
    );
  }
  return Slug.parse(derived);
};
