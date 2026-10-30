import { basename } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { parseOptionalString } from '@src/domain/value/parsers/parse-optional-string.ts';
import { parsePositiveInt } from '@src/domain/value/parsers/parse-positive-int.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

/** Field tag for `repository.name` validation failures, shared across the name parsers. */
const FIELD_REPOSITORY_NAME = 'repository.name';

/**
 * One per-module verify gate, so a post-verify run executes only the gates whose `pathPrefix`
 * matches the diff footprint instead of one monolithic `verifyScript`.
 */
export interface VerifyGate {
  /** Repo-relative POSIX prefix; `''` is the catch-all a legacy `verifyScript` normalises to. */
  readonly pathPrefix: string;
  readonly command: string;
  /** Falls back to the repo's `verifyTimeout`, then the shell runner default. */
  readonly timeoutMs?: number;
}

/** Strip leading `./` and `/` so a prefix compares against git's bare repo-relative paths; `.` is the root. */
export const canonicalGatePrefix = (prefix: string): string => {
  const stripped = prefix.replace(/^(?:\.\/|\/)+/, '');
  return stripped === '.' ? '' : stripped;
};

/**
 * Collapse the legacy and structured verify inputs into ONE gate list: `verifyGates` wins when
 * present AND non-empty; otherwise a non-blank `verifyScript` becomes the single catch-all gate
 * `{ pathPrefix: '', command }`. Neither configured yields `[]`.
 */
export const normalizeVerifyGates = (
  verifyScript: string | undefined,
  verifyGates: readonly VerifyGate[] | undefined
): readonly VerifyGate[] => {
  if (verifyGates !== undefined && verifyGates.length > 0) return verifyGates;
  const command = verifyScript?.trim() ?? '';
  if (command.length === 0) return [];
  return [{ pathPrefix: '', command }];
};

/**
 * `id` is the identity; `slug` is a renamable CLI handle; `path` is a per-machine fact, never
 * identity; `name` defaults to the path basename.
 */
export interface Repository extends Entity<RepositoryId> {
  readonly slug: Slug;
  readonly name: string;
  readonly path: AbsolutePath;
  readonly verifyScript?: string;
  /** Wins over `verifyScript` when present (see {@link normalizeVerifyGates}); never persisted empty. */
  readonly verifyGates?: readonly VerifyGate[];
  readonly verifyTimeout?: number;
  readonly setupScript?: string;
  /** Markdown guidance installed into every AI session on how to prepare the tree (from `detect-skills`). */
  readonly setupSkill?: string;
  /** Markdown guidance on verifying changes; same authoring path as `setupSkill`. */
  readonly verifySkill?: string;
  /** Skill names the readiness AI proposed; `offer-skill-suggestions` is the human gate that installs them. */
  readonly suggestedSkills?: readonly string[];
}

export interface RepositoryCreateInput {
  readonly id?: RepositoryId;
  readonly path: AbsolutePath;
  readonly name?: string;
  /** Optional. Defaults to `kebab-case(name)` (which itself defaults to `basename(path)`). */
  readonly slug?: Slug;
  readonly verifyScript?: string;
  readonly verifyGates?: readonly VerifyGate[];
  readonly verifyTimeout?: number;
  readonly setupScript?: string;
  readonly setupSkill?: string;
  readonly verifySkill?: string;
  readonly suggestedSkills?: readonly string[];
}

export const createRepository = (input: RepositoryCreateInput): Result<Repository, ValidationError> => {
  const nameResult = resolveName(input.name, input.path);
  if (!nameResult.ok) return Result.error(nameResult.error);

  const slugResult = Slug.derive('repository.slug', input.slug, nameResult.value);
  if (!slugResult.ok) return Result.error(slugResult.error);

  const setters: ReadonlyArray<(repo: Repository) => Result<Repository, ValidationError>> = [
    (r) => setRepositoryVerifyScript(r, input.verifyScript),
    (r) => setRepositorySetupScript(r, input.setupScript),
    (r) => setRepositorySetupSkill(r, input.setupSkill),
    (r) => setRepositoryVerifySkill(r, input.verifySkill),
    (r) => setRepositoryVerifyGates(r, input.verifyGates),
    (r) => setRepositoryVerifyTimeout(r, input.verifyTimeout),
  ];
  let repo: Repository = {
    id: input.id ?? RepositoryId.generate(),
    slug: slugResult.value,
    name: nameResult.value,
    path: input.path,
    ...suggestedSkillsPart(input.suggestedSkills),
  };
  for (const set of setters) {
    const next = set(repo);
    if (!next.ok) return next;
    repo = next.value;
  }
  return Result.ok(repo);
};

type OptionalField =
  'verifyScript' | 'setupScript' | 'setupSkill' | 'verifySkill' | 'verifyGates' | 'verifyTimeout' | 'suggestedSkills';

/** Set an optional field, or drop the key on `undefined` — the persisted shape never holds an explicit undefined. */
const withOptional = (repo: Repository, key: OptionalField, value: Repository[OptionalField]): Repository => {
  if (value !== undefined) return { ...repo, [key]: value };
  const { [key]: _drop, ...rest } = repo;
  void _drop;
  return rest;
};

const setOptionalText =
  (key: 'verifyScript' | 'setupScript' | 'setupSkill' | 'verifySkill') =>
  (repo: Repository, value: string | undefined): Result<Repository, ValidationError> => {
    const next = parseOptionalString(`repository.${key}`, value);
    if (!next.ok) return Result.error(next.error);
    return Result.ok(withOptional(repo, key, next.value));
  };

export const setRepositoryVerifyScript = setOptionalText('verifyScript');

/** Trims commands and drops blank-command gates; an all-blank input clears the field. */
export const setRepositoryVerifyGates = (
  repo: Repository,
  gates: readonly VerifyGate[] | undefined
): Result<Repository, ValidationError> => {
  const part = verifyGatesPart(gates);
  if (!part.ok) return Result.error(part.error);
  return Result.ok(withOptional(repo, 'verifyGates', part.value.verifyGates));
};

export const setRepositoryVerifyTimeout = (
  repo: Repository,
  ms: number | undefined
): Result<Repository, ValidationError> => {
  if (ms === undefined) return Result.ok(withOptional(repo, 'verifyTimeout', undefined));
  const next = parsePositiveInt('repository.verifyTimeout', ms);
  if (!next.ok) return Result.error(next.error);
  return Result.ok({ ...repo, verifyTimeout: next.value });
};

export const setRepositorySetupScript = setOptionalText('setupScript');

export const setRepositorySetupSkill = setOptionalText('setupSkill');

export const setRepositoryVerifySkill = setOptionalText('verifySkill');

/** Local path is a per-machine fact, not identity — change it freely without touching `id`. */
export const setRepositoryPath = (repo: Repository, path: AbsolutePath): Repository => ({
  ...repo,
  path,
});

export const setRepositoryName = (repo: Repository, name: string): Result<Repository, ValidationError> => {
  const parsed = parseRequiredString(FIELD_REPOSITORY_NAME, name);
  if (!parsed.ok) return Result.error(parsed.error);
  return Result.ok({ ...repo, name: parsed.value });
};

/** Slug rename. The owning project enforces project-scoped uniqueness — see {@link updateRepository}. */
export const setRepositorySlug = (repo: Repository, slug: Slug): Repository => ({
  ...repo,
  slug,
});

/** Trims and de-duplicates; `undefined` or an all-blank list clears the field. Never fails. */
export const setRepositorySuggestedSkills = (repo: Repository, names: readonly string[] | undefined): Repository =>
  withOptional(repo, 'suggestedSkills', suggestedSkillsPart(names).suggestedSkills);

const suggestedSkillsPart = (
  input: readonly string[] | undefined
): { readonly suggestedSkills?: readonly string[] } => {
  if (input === undefined) return {};
  const names = [...new Set(input.map((s) => s.trim()).filter((s) => s.length > 0))];
  return names.length > 0 ? { suggestedSkills: names } : {};
};

/**
 * Trim the command (blank → the gate is skipped) and validate `timeoutMs`. The prefix loses only a
 * leading `./` or `/`; it is NOT trimmed, since whitespace in a POSIX path is significant.
 */
const normalizeVerifyGate = (gate: VerifyGate): Result<VerifyGate | undefined, ValidationError> => {
  const command = gate.command.trim();
  if (command.length === 0) return Result.ok(undefined);

  let timeoutMs: number | undefined;
  if (gate.timeoutMs !== undefined) {
    const parsed = parsePositiveInt('repository.verifyGates[].timeoutMs', gate.timeoutMs);
    if (!parsed.ok) return Result.error(parsed.error);
    timeoutMs = parsed.value;
  }

  return Result.ok({
    pathPrefix: canonicalGatePrefix(gate.pathPrefix),
    command,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
};

/** `{ verifyGates }` only when at least one gate survives, so no empty array lands on disk. */
const verifyGatesPart = (
  input: readonly VerifyGate[] | undefined
): Result<{ readonly verifyGates?: readonly VerifyGate[] }, ValidationError> => {
  if (input === undefined) return Result.ok({});
  const gates: VerifyGate[] = [];
  for (const gate of input) {
    const result = normalizeVerifyGate(gate);
    if (!result.ok) return Result.error(result.error);
    if (result.value !== undefined) gates.push(result.value);
  }
  return Result.ok(gates.length > 0 ? { verifyGates: gates } : {});
};

const resolveName = (candidate: string | undefined, path: AbsolutePath): Result<string, ValidationError> => {
  if (candidate === undefined) {
    const fallback = basename(path);
    if (fallback.length === 0) {
      return Result.error(
        new ValidationError({
          field: FIELD_REPOSITORY_NAME,
          value: path,
          message: 'could not derive repository name from path',
          hint: 'pass an explicit name',
        })
      );
    }
    return Result.ok(fallback);
  }
  return parseRequiredString(FIELD_REPOSITORY_NAME, candidate);
};
