import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';
import { EVAL_FLOWS, type EvalFlow, FixtureSchema } from './fixture-schema.ts';
import type { Fixture } from './types.ts';

export interface FixtureFilter {
  readonly flows?: readonly EvalFlow[];
  readonly tier?: 'regression' | 'capability';
  /** Glob over fixture ids; `*` matches any run of characters. Comma-separated for several. */
  readonly idGlob?: string;
}

export interface LoadedFixtures {
  readonly fixtures: readonly Fixture[];
  /** sha256 over every file of every returned fixture — pins which fixture set produced a results file. */
  readonly fixtureSetHash: string;
}

type LoadError = ParseError | StorageError;

const ioError = (path: string, cause: unknown): StorageError =>
  new StorageError({ subCode: 'io', message: `${path}: ${messageOf(cause)}`, path, cause });

const schemaError = (path: string, message: string, cause?: unknown): ParseError =>
  new ParseError({ subCode: 'schema-mismatch', message: `${path}: ${message}`, cause });

/** Every file under `dir`, repo-relative and sorted — the stable walk order the set hash depends on. */
export const walkFiles = async (dir: string): Promise<readonly string[]> => {
  const out: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(relative(dir, full));
    }
  };
  await visit(dir);
  return out.sort();
};

const exists = async (path: string): Promise<boolean> =>
  fs.stat(path).then(
    () => true,
    () => false
  );

/** The fixture-relative paths a spec references and that therefore must exist on disk. */
const referencedPaths = (spec: Fixture): readonly string[] => {
  const base = ['repo'];
  switch (spec.flow) {
    case 'evaluate':
      return [...base, ...spec.variants.map((v) => v.patch), ...('command' in spec.oracle ? ['oracle'] : [])];
    case 'implement':
      return [...base, spec.referencePatch, 'oracle'];
    case 'detect-scripts':
      return [...base, spec.brokenPatch];
    case 'select-candidate':
      return [
        ...base,
        spec.candidates.a.summary,
        spec.candidates.a.patch,
        spec.candidates.b.summary,
        spec.candidates.b.patch,
        'oracle',
      ];
  }
};

const loadOne = async (flow: EvalFlow, dir: string, name: string): Promise<Result<Fixture, LoadError>> => {
  const specPath = join(dir, 'fixture.json');
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(specPath, 'utf8'));
  } catch (cause) {
    const missing = (cause as { code?: unknown }).code === 'ENOENT';
    return Result.error(
      missing
        ? ioError(specPath, 'fixture.json is missing')
        : new ParseError({ subCode: 'invalid-json', message: `${specPath}: ${messageOf(cause)}`, cause })
    );
  }
  const parsed = FixtureSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return Result.error(schemaError(specPath, issues, parsed.error));
  }
  const fixture: Fixture = { ...parsed.data, dir };
  if (fixture.flow !== flow) {
    return Result.error(schemaError(specPath, `flow '${fixture.flow}' does not match its directory '${flow}'`));
  }
  if (fixture.id !== name) {
    return Result.error(schemaError(specPath, `id '${fixture.id}' does not match its directory '${name}'`));
  }
  for (const rel of referencedPaths(fixture)) {
    if (!(await exists(join(dir, rel)))) return Result.error(ioError(join(dir, rel), 'referenced path is missing'));
  }
  return Result.ok(fixture);
};

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

export const matchesFilter = (fixture: Fixture, filter: FixtureFilter): boolean => {
  if (filter.flows !== undefined && filter.flows.length > 0 && !filter.flows.includes(fixture.flow)) return false;
  if (filter.tier !== undefined && fixture.tier !== filter.tier) return false;
  if (filter.idGlob !== undefined) {
    const patterns = filter.idGlob.split(',').map((g) => globToRegExp(g.trim()));
    if (!patterns.some((re) => re.test(fixture.id))) return false;
  }
  return true;
};

const hashFixtures = async (fixtures: readonly Fixture[]): Promise<string> => {
  const hash = createHash('sha256');
  for (const fixture of fixtures) {
    for (const rel of await walkFiles(fixture.dir)) {
      hash.update(`${fixture.flow}/${fixture.id}/${rel}\0`);
      hash.update(await fs.readFile(join(fixture.dir, rel)));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
};

/**
 * Load every fixture under `<root>/<flow>/<id>/`. Every fixture is validated (schema, id matches
 * its directory, every referenced file exists) BEFORE the filter applies, and duplicate ids are an
 * error even across flows — a fixture id is the join key of every results file. Returns fixtures
 * sorted by flow then id.
 */
export const loadFixtures = async (
  root: string,
  filter: FixtureFilter = {}
): Promise<Result<LoadedFixtures, LoadError>> => {
  const all: Fixture[] = [];
  const seen = new Map<string, string>();
  for (const flow of EVAL_FLOWS) {
    const flowDir = join(root, flow);
    let names: string[];
    try {
      names = (await fs.readdir(flowDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (cause) {
      if ((cause as { code?: unknown }).code === 'ENOENT') continue;
      return Result.error(ioError(flowDir, cause));
    }
    for (const name of names.sort()) {
      const loaded = await loadOne(flow, join(flowDir, name), name);
      if (!loaded.ok) return Result.error(loaded.error);
      const previous = seen.get(loaded.value.id);
      if (previous !== undefined) {
        return Result.error(
          schemaError(join(flowDir, name), `duplicate fixture id '${loaded.value.id}' (also at ${previous})`)
        );
      }
      seen.set(loaded.value.id, join(flowDir, name));
      all.push(loaded.value);
    }
  }
  const fixtures = all.filter((f) => matchesFilter(f, filter));
  try {
    return Result.ok({ fixtures, fixtureSetHash: await hashFixtures(fixtures) });
  } catch (cause) {
    return Result.error(ioError(root, cause));
  }
};
