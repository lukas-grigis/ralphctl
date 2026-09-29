import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { VerifyScriptSignal } from '@src/domain/signal.ts';
import { buildDetectScriptsPrompt } from '@src/integration/ai/prompts/detect-scripts/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { detectScriptsOutputContract } from '@src/application/flows/detect-scripts/leaves/propose.contract.ts';
import { readOnlySignalsSession } from '@src/application/flows/_shared/signals-session.ts';
import { runPathsFor } from '@src/application/flows/_shared/allocate-run-dir.ts';
import { gradeDetectScripts } from '../grade.ts';
import { materialize } from '../workspace.ts';
import { type FlowAdapter, type GradeToolbox, validateWith } from './adapter.ts';
import { absPath, asFlow } from './narrow.ts';

/**
 * detect-scripts — one read-only repo inventory (`readOnlySignalsSession`, as production). Graded by
 * OUTCOME: the proposed `verify-script` must exit 0 on a fresh clean copy and non-zero on a fresh
 * copy with the fixture's `broken.patch` applied. Running the command instead of string-matching it
 * follows "grade what the agent produced, not the path it took" (Anthropic, Demystifying evals).
 */

interface ScriptRun {
  readonly passed: boolean;
  readonly output: string;
}

const runInFreshCopy = async (
  toolbox: GradeToolbox,
  fixtureDir: string,
  patchRel: string | undefined,
  script: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
) => {
  const ws = await materialize(
    { git: toolbox.git, ...(toolbox.tmpRoot !== undefined ? { tmpRoot: toolbox.tmpRoot } : {}) },
    fixtureDir,
    patchRel
  );
  if (!ws.ok) return Result.error(ws.error);
  try {
    const ran = await toolbox.shell.run(ws.value.repo, script, {
      timeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!ran.ok) return Result.error(ran.error);
    return Result.ok<ScriptRun>({ passed: ran.value.passed, output: ran.value.output });
  } finally {
    await ws.value.cleanup();
  }
};

export const detectScriptsAdapter: FlowAdapter = {
  flow: 'detect-scripts',

  plans: () => [{ variant: 'default' }],

  async prepare(ctx) {
    const runDir = absPath(join(String(ctx.workspace.root), 'run'));
    if (!runDir.ok) return Result.error(runDir.error);
    const paths = runPathsFor(runDir.value);
    if (!paths.ok) return Result.error(paths.error);
    const outputContractSection = renderContractSectionFor(detectScriptsOutputContract, runDir.value);
    const prompt = await buildDetectScriptsPrompt(ctx.loader, {
      repositoryPath: String(ctx.workspace.repo),
      outputContractSection,
    });
    if (!prompt.ok) return Result.error(prompt.error);
    return Result.ok({
      session: readOnlySignalsSession({
        cwd: ctx.workspace.repo,
        prompt: prompt.value,
        model: ctx.row.model,
        signalsFile: paths.value.signalsFile,
        outputDir: runDir.value,
        bodyFile: paths.value.bodyFile,
        ...(ctx.row.effort !== undefined ? { effort: ctx.row.effort } : {}),
        ...(ctx.abortSignal !== undefined ? { abortSignal: ctx.abortSignal } : {}),
      }),
      outputDir: runDir.value,
      selfContainedContext: `Repository under inspection: \`${String(ctx.workspace.repo)}\`\n\n${outputContractSection}`,
      nudges: false,
      validate: validateWith(detectScriptsOutputContract),
    });
  },

  async grade(ctx, outcome) {
    const fixture = asFlow(ctx.fixture, 'detect-scripts');
    if (!fixture.ok) return Result.error(fixture.error);
    const proposed = outcome.signals.find((s): s is VerifyScriptSignal => s.type === 'verify-script')?.command ?? null;
    const expectedVerifyScript = fixture.value.expected?.verifyScript;
    if (proposed === null) {
      return Result.ok(
        gradeDetectScripts({
          valid: outcome.valid,
          proposed,
          cleanPasses: null,
          brokenFails: null,
          ...(expectedVerifyScript !== undefined ? { expectedVerifyScript } : {}),
        })
      );
    }
    const { commandTimeoutMs } = fixture.value;
    const clean = await runInFreshCopy(
      ctx.toolbox,
      fixture.value.dir,
      undefined,
      proposed,
      commandTimeoutMs,
      ctx.abortSignal
    );
    if (!clean.ok) return Result.error(clean.error);
    const broken = await runInFreshCopy(
      ctx.toolbox,
      fixture.value.dir,
      fixture.value.brokenPatch,
      proposed,
      commandTimeoutMs,
      ctx.abortSignal
    );
    if (!broken.ok) return Result.error(broken.error);
    const wrote = await writeTextAtomic(
      join(String(ctx.artifactDir), 'oracle.txt'),
      `# proposed\n${proposed}\n\n# clean copy (passed=${String(clean.value.passed)})\n${clean.value.output}\n\n# broken copy (passed=${String(broken.value.passed)})\n${broken.value.output}\n`
    );
    if (!wrote.ok) return Result.error(wrote.error);
    return Result.ok(
      gradeDetectScripts({
        valid: outcome.valid,
        proposed,
        cleanPasses: clean.value.passed,
        brokenFails: !broken.value.passed,
        ...(expectedVerifyScript !== undefined ? { expectedVerifyScript } : {}),
      })
    );
  },

  async dryRun(ctx) {
    const fixture = asFlow(ctx.fixture, 'detect-scripts');
    const command = fixture.ok ? (fixture.value.expected?.verifyScript ?? 'true') : 'true';
    return { signals: [{ type: 'verify-script', command }] };
  },
};
