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

/** Field tag for `repository.name` validation failures, shared across the name parsers. */
const FIELD_REPOSITORY_NAME = 'repository.name';

/**
 * One structured per-module verify gate. A monorepo-style repo chains module gates inside a
 * single opaque {@link Repository.verifyScript}, so every verify run pays for every module. A
 * `VerifyGate` carves that into addressable units so a post-verify run can execute only the
 * gates whose `pathPrefix` matches the attempt's diff footprint.
 *
 *  - `pathPrefix` — POSIX-style path prefix relative to the repo root that scopes the gate.
 *    `''` (empty string) matches everything — the catch-all gate a legacy `verifyScript`
 *    normalises to.
 *  - `command`    — the verbatim shell line to run for this module.
 *  - `timeoutMs`  — optional per-gate wall-clock cap. Falls back to the repo's `verifyTimeout`
 *    (then the shell runner default) when absent.
 */
export interface VerifyGate {
  readonly pathPrefix: string;
  readonly command: string;
  readonly timeoutMs?: number;
}

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
  readonly verifyScript?: string;
  /**
   * Structured per-module verify gates. Precedence (resolved by consumers, not here): when
   * `verifyGates` is present AND non-empty it WINS — the multi-gate executor runs these and
   * ignores `verifyScript`. {@link verifyScript} remains for legacy repos (no gates configured)
   * and as the `detect-scripts` fallback when the AI proposes no structured gates. The
   * factory/setter never persists an empty array — an all-blank input clears the field — so
   * "present and non-empty" collapses to "present" on read.
   */
  readonly verifyGates?: readonly VerifyGate[];
  readonly verifyTimeout?: number;
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
   * {@link verifyScript}. Same authoring path as `setupSkill`.
   */
  readonly verifySkill?: string;
  /**
   * Kebab-case skill names the readiness flow's AI proposed linking into the repo (the
   * `skill-suggestions` signal). Persisted so the operator has a durable record of what was
   * recommended; the `offer-skill-suggestions` readiness leaf is the human gate that turns a
   * suggestion into an installed / stubbed skill. Plain optional-on-read field — persisted
   * `project.json` files written before this field existed simply omit it.
   */
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

  const slugResult = resolveSlug(input.slug, nameResult.value);
  if (!slugResult.ok) return Result.error(slugResult.error);

  const verifyScript = parseOptionalString('repository.verifyScript', input.verifyScript);
  if (!verifyScript.ok) return Result.error(verifyScript.error);

  const setupScript = parseOptionalString('repository.setupScript', input.setupScript);
  if (!setupScript.ok) return Result.error(setupScript.error);

  const setupSkill = parseOptionalString('repository.setupSkill', input.setupSkill);
  if (!setupSkill.ok) return Result.error(setupSkill.error);

  const verifySkill = parseOptionalString('repository.verifySkill', input.verifySkill);
  if (!verifySkill.ok) return Result.error(verifySkill.error);

  const verifyGates = verifyGatesPart(input.verifyGates);
  if (!verifyGates.ok) return Result.error(verifyGates.error);

  let verifyTimeout: number | undefined;
  if (input.verifyTimeout !== undefined) {
    const parsed = parsePositiveInt('repository.verifyTimeout', input.verifyTimeout);
    if (!parsed.ok) return Result.error(parsed.error);
    verifyTimeout = parsed.value;
  }

  return Result.ok({
    id: input.id ?? RepositoryId.generate(),
    slug: slugResult.value,
    name: nameResult.value,
    path: input.path,
    ...suggestedSkillsPart(input.suggestedSkills),
    ...(verifyScript.value !== undefined ? { verifyScript: verifyScript.value } : {}),
    ...(verifyGates.value.verifyGates !== undefined ? { verifyGates: verifyGates.value.verifyGates } : {}),
    ...(verifyTimeout !== undefined ? { verifyTimeout } : {}),
    ...(setupScript.value !== undefined ? { setupScript: setupScript.value } : {}),
    ...(setupSkill.value !== undefined ? { setupSkill: setupSkill.value } : {}),
    ...(verifySkill.value !== undefined ? { verifySkill: verifySkill.value } : {}),
  });
};

export const setRepositoryVerifyScript = (
  repo: Repository,
  script: string | undefined
): Result<Repository, ValidationError> => {
  const next = parseOptionalString('repository.verifyScript', script);
  if (!next.ok) return Result.error(next.error);
  if (next.value === undefined) {
    const { verifyScript: _drop, ...rest } = repo;
    void _drop;
    return Result.ok(rest);
  }
  return Result.ok({ ...repo, verifyScript: next.value });
};

/**
 * Replace the repository's structured `verifyGates`. Normalised through the same
 * {@link verifyGatesPart} the factory uses (trim commands, drop blank-command gates, drop the
 * field entirely when nothing survives) so the field round-trips cleanly and an all-blank input
 * clears it — a repo with no gates persists without an empty array on disk. Returns a
 * `ValidationError` when a surviving gate carries a non-positive `timeoutMs`.
 */
export const setRepositoryVerifyGates = (
  repo: Repository,
  gates: readonly VerifyGate[] | undefined
): Result<Repository, ValidationError> => {
  const part = verifyGatesPart(gates);
  if (!part.ok) return Result.error(part.error);
  if (part.value.verifyGates === undefined) {
    const { verifyGates: _drop, ...rest } = repo;
    void _drop;
    return Result.ok(rest);
  }
  return Result.ok({ ...repo, verifyGates: part.value.verifyGates });
};

export const setRepositoryVerifyTimeout = (
  repo: Repository,
  ms: number | undefined
): Result<Repository, ValidationError> => {
  if (ms === undefined) {
    const { verifyTimeout: _drop, ...rest } = repo;
    void _drop;
    return Result.ok(rest);
  }
  const next = parsePositiveInt('repository.verifyTimeout', ms);
  if (!next.ok) return Result.error(next.error);
  return Result.ok({ ...repo, verifyTimeout: next.value });
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
  const parsed = parseRequiredString(FIELD_REPOSITORY_NAME, name);
  if (!parsed.ok) return Result.error(parsed.error);
  return Result.ok({ ...repo, name: parsed.value });
};

/** Slug rename. The owning project enforces project-scoped uniqueness — see {@link updateRepository}. */
export const setRepositorySlug = (repo: Repository, slug: Slug): Repository => ({
  ...repo,
  slug,
});

/**
 * Replace the repository's `suggestedSkills` record. Trims / de-duplicates via the same
 * {@link suggestedSkillsPart} normalisation the factory uses, so the field round-trips cleanly.
 * `undefined` or an all-blank list clears the field entirely (a clean repo persists without an
 * empty array on disk). Never fails — suggestion names are free-form kebab strings the AI
 * proposes, not validated value objects.
 */
export const setRepositorySuggestedSkills = (repo: Repository, names: readonly string[] | undefined): Repository => {
  const part = suggestedSkillsPart(names);
  if (part.suggestedSkills === undefined) {
    const { suggestedSkills: _drop, ...rest } = repo;
    void _drop;
    return rest;
  }
  return { ...repo, suggestedSkills: part.suggestedSkills };
};

/**
 * Trim each suggested skill name, drop blanks, de-duplicate. Returns `{ suggestedSkills }` only
 * when at least one name survives so the factory omits the field entirely otherwise (a clean
 * repo round-trips without an empty array on disk).
 */
const suggestedSkillsPart = (
  input: readonly string[] | undefined
): { readonly suggestedSkills?: readonly string[] } => {
  if (input === undefined) return {};
  const names = [...new Set(input.map((s) => s.trim()).filter((s) => s.length > 0))];
  return names.length > 0 ? { suggestedSkills: names } : {};
};

/**
 * Normalise a `verifyGates` input. Trims each gate's `command`, drops gates whose command is
 * blank, trims the `pathPrefix` is NOT done — a prefix is matched verbatim against POSIX paths,
 * so leading/trailing whitespace in a prefix would be a deliberate (if unusual) author choice;
 * we only validate the load-bearing `command` and the optional `timeoutMs`. Returns
 * `{ verifyGates }` only when at least one gate survives so the factory omits the field entirely
 * otherwise (a repo with no gates round-trips without an empty array on disk). A surviving gate
 * with a non-positive `timeoutMs` fails the whole parse.
 */
const verifyGatesPart = (
  input: readonly VerifyGate[] | undefined
): Result<{ readonly verifyGates?: readonly VerifyGate[] }, ValidationError> => {
  if (input === undefined) return Result.ok({});
  const gates: VerifyGate[] = [];
  for (const gate of input) {
    const command = typeof gate.command === 'string' ? gate.command.trim() : '';
    if (command.length === 0) continue;
    let timeoutMs: number | undefined;
    if (gate.timeoutMs !== undefined) {
      const parsed = parsePositiveInt('repository.verifyGates[].timeoutMs', gate.timeoutMs);
      if (!parsed.ok) return Result.error(parsed.error);
      timeoutMs = parsed.value;
    }
    gates.push({
      pathPrefix: typeof gate.pathPrefix === 'string' ? gate.pathPrefix : '',
      command,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
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
