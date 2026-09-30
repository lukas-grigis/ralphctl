import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AbortError } from '@src/domain/value/error/abort-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { CommandOracle } from './fixture-schema.ts';
import { materialize, type Workspace, type WorkspaceDeps } from './workspace.ts';
import type { Fixture } from './types.ts';

/**
 * Hidden-oracle runner. The oracle is ground truth the RUNNER establishes after a trial — the model
 * never sees it: "Make your graders resistant to bypasses or hacks" (Anthropic, Demystifying evals).
 * Two protections:
 *
 *  1. `oracle/` lives only in the fixture directory and is copied into the workspace here, after the
 *     model's session has ended (or, for `check`, into a workspace no model ever touched).
 *  2. `protectedPaths` are RESTORED from the fixture's pristine `repo/` before the command runs, so a
 *     model that weakened a visible test still faces the original assertion.
 */

export interface OracleResult {
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly output: string;
}

export interface OracleDeps {
  readonly shell: ShellScriptRunner;
  readonly timeoutMs?: number;
}

const DEFAULT_ORACLE_TIMEOUT_MS = 120_000;

const restoreProtectedPaths = async (
  fixtureDir: string,
  repo: AbsolutePath,
  paths: readonly string[]
): Promise<void> => {
  const root = resolve(String(repo));
  for (const rel of paths) {
    const target = resolve(root, rel);
    // The fixture schema already rejects these entries; this guards the `rm -rf` itself against a
    // caller that built a CommandOracle without the schema.
    if (!target.startsWith(`${root}${sep}`)) {
      throw new Error(`protected path escapes the workspace: ${JSON.stringify(rel)}`);
    }
    await fs.rm(target, { recursive: true, force: true });
    const pristine = join(fixtureDir, 'repo', rel);
    const present = await fs.stat(pristine).then(
      () => true,
      () => false
    );
    if (present) await fs.cp(pristine, target, { recursive: true });
  }
};

export const runOracle = async (
  deps: OracleDeps,
  ws: Workspace,
  fixtureDir: string,
  oracle: CommandOracle,
  signal?: AbortSignal
): Promise<Result<OracleResult, StorageError | AbortError>> => {
  try {
    await restoreProtectedPaths(fixtureDir, ws.repo, oracle.protectedPaths);
    await fs.rm(join(String(ws.repo), 'oracle'), { recursive: true, force: true });
    await fs.cp(join(fixtureDir, 'oracle'), join(String(ws.repo), 'oracle'), { recursive: true });
  } catch (cause) {
    return Result.error(
      new StorageError({ subCode: 'io', message: `oracle setup failed: ${messageOf(cause)}`, path: fixtureDir, cause })
    );
  }
  const ran = await deps.shell.run(ws.repo, oracle.command, {
    timeoutMs: deps.timeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!ran.ok) return Result.error(ran.error);
  return Result.ok({ passed: ran.value.passed, exitCode: ran.value.exitCode, output: ran.value.output });
};

export interface CheckOutcome {
  readonly fixtureId: string;
  readonly flow: Fixture['flow'];
  /** One line per proven / refuted label, in a stable order. */
  readonly lines: readonly string[];
  readonly ok: boolean;
}

export interface CheckDeps {
  readonly workspace: WorkspaceDeps;
  readonly oracle: OracleDeps;
}

interface Expectation {
  readonly name: string;
  readonly patchRel: string | undefined;
  readonly oracleShouldPass: boolean;
}

/** The (variant patch, expected oracle result) pairs a fixture's labels claim. */
const expectationsOf = (fixture: Fixture): readonly Expectation[] => {
  switch (fixture.flow) {
    case 'evaluate':
      return fixture.variants.map((v) => ({
        name: `variant ${v.name}`,
        patchRel: v.patch,
        oracleShouldPass: v.expect.status === 'passed',
      }));
    case 'implement':
      return [
        { name: 'unmodified repo (must fail — the bug is real)', patchRel: undefined, oracleShouldPass: false },
        {
          name: 'reference patch (must pass — the task is solvable)',
          patchRel: fixture.referencePatch,
          oracleShouldPass: true,
        },
      ];
    case 'select-candidate': {
      const winner = fixture.winner;
      const loser = winner === 'a' ? 'b' : 'a';
      return [
        { name: `winner ${winner}`, patchRel: fixture.candidates[winner].patch, oracleShouldPass: true },
        { name: `loser ${loser}`, patchRel: fixture.candidates[loser].patch, oracleShouldPass: false },
      ];
    }
    case 'detect-scripts':
      return [];
  }
};

/**
 * Detect-scripts labels: both copies must materialize (the broken patch must apply) and, when the
 * fixture names an `expected.verifyScript`, that script must pass on the clean copy and fail on the
 * broken one — so the fixture is proven to be a repo whose verify gate can tell the two apart.
 */
const checkDetectScripts = async (
  deps: CheckDeps,
  fixture: Fixture & { flow: 'detect-scripts' },
  signal?: AbortSignal
): Promise<Result<CheckOutcome, StorageError | AbortError>> => {
  const script = fixture.expected?.verifyScript;
  const lines: string[] = [];
  let ok = true;
  for (const variant of [
    { name: 'clean copy', patchRel: undefined, shouldPass: true },
    { name: 'broken copy', patchRel: fixture.brokenPatch, shouldPass: false },
  ]) {
    const ws = await materialize(deps.workspace, fixture.dir, variant.patchRel);
    if (!ws.ok) return Result.error(ws.error);
    try {
      if (script === undefined) {
        lines.push(`ok   ${variant.name} materializes`);
        continue;
      }
      const ran = await deps.oracle.shell.run(ws.value.repo, script, {
        timeoutMs: fixture.commandTimeoutMs,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!ran.ok) return Result.error(ran.error);
      const good = ran.value.passed === variant.shouldPass;
      ok &&= good;
      lines.push(
        `${good ? 'ok  ' : 'FAIL'} ${variant.name}: \`${script}\` ${ran.value.passed ? 'passed' : 'failed'}, expected ${variant.shouldPass ? 'pass' : 'fail'}`
      );
    } finally {
      await ws.value.cleanup();
    }
  }
  return Result.ok({ fixtureId: fixture.id, flow: fixture.flow, ok, lines });
};

/**
 * Label proof — the equivalent-mutant guard. Every claim a fixture makes is checked against its
 * oracle in a workspace no model has touched: a clean / winning / reference variant must exit 0, a
 * defect / losing / unmodified one must exit non-zero. A fixture whose label the oracle cannot
 * prove is rejected (engineering judgment: a seeded defect that no hidden check can observe may be an
 * equivalent mutant, and grading a model against it would measure the fixture, not the model).
 * Reviewer-labelled (`oracle.kind: "none"`) fixtures are accepted as-is; their two named reviewers
 * are the proof.
 */
export const checkFixture = async (
  deps: CheckDeps,
  fixture: Fixture,
  signal?: AbortSignal
): Promise<Result<CheckOutcome, StorageError | AbortError>> => {
  if (fixture.flow === 'detect-scripts') return checkDetectScripts(deps, fixture, signal);
  if (fixture.flow === 'evaluate' && !('command' in fixture.oracle)) {
    return Result.ok({
      fixtureId: fixture.id,
      flow: fixture.flow,
      ok: true,
      lines: [`reviewer-labelled (${fixture.oracle.reviewedBy.join(', ')}) — no oracle to run`],
    });
  }
  const oracle = fixture.oracle;
  if (!('command' in oracle)) return Result.ok({ fixtureId: fixture.id, flow: fixture.flow, ok: true, lines: [] });

  const lines: string[] = [];
  let ok = true;
  for (const expectation of expectationsOf(fixture)) {
    const ws = await materialize(deps.workspace, fixture.dir, expectation.patchRel);
    if (!ws.ok) return Result.error(ws.error);
    try {
      const ran = await runOracle(deps.oracle, ws.value, fixture.dir, oracle, signal);
      if (!ran.ok) return Result.error(ran.error);
      const good = ran.value.passed === expectation.oracleShouldPass;
      ok &&= good;
      lines.push(
        `${good ? 'ok  ' : 'FAIL'} ${expectation.name}: oracle ${ran.value.passed ? 'passed' : 'failed'}, expected ${expectation.oracleShouldPass ? 'pass' : 'fail'}`
      );
    } finally {
      await ws.value.cleanup();
    }
  }
  return Result.ok({ fixtureId: fixture.id, flow: fixture.flow, ok, lines });
};
