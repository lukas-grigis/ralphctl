import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { recordTaskEscalation, recordTaskEvaluatorEffortEscalation } from '@src/domain/entity/task-settle.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { emptySkillSource } from '@tests/fixtures/skills-fakes.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import { evaluatorLeaf } from '@src/application/flows/implement/leaves/evaluator.ts';

describe('evaluatorLeaf', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  /**
   * The audit-[09] evaluator contract REQUIRES exactly one `evaluation` signal per spawn. We
   * inject a minimal passing evaluation through `signals['evaluate']` so the post-spawn
   * `validateSignalsFile` step succeeds; these tests cover the leaf's pre-spawn prompt-write
   * side effect, not the contract-validation branches (those live in `evaluator-contract.test.ts`).
   */
  const buildDeps = () => ({
    provider: createFakeAiProvider({
      responses: { evaluate: '' },
      signals: {
        evaluate: [
          {
            type: 'evaluation',
            status: 'passed',
            // Full floor set so the signal passes the floor-dimension refinement cleanly — these
            // tests cover the leaf's pre-spawn prompt-write side effect, not the verdict, but a
            // vacuous PASS would now trip a corrective retry and muddy the assertions.
            dimensions: [
              { dimension: 'correctness', passed: true, finding: 'all good' },
              { dimension: 'completeness', passed: true, finding: 'all steps shipped' },
              { dimension: 'safety', passed: true, finding: 'inputs validated' },
              { dimension: 'consistency', passed: true, finding: 'matches siblings' },
            ],
            timestamp: FIXED_NOW,
          },
        ],
      },
    }),
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    publishSignal: () => {},
    // The contract-driven evaluator renders `evaluation.md` via the WriteFile port. These
    // legacy tests cover prompt persistence (pre-spawn); a no-op writer is sufficient here.
    writeFile: async () => Result.ok(undefined),
    cwd: absolutePath('/tmp/ralph/fake-cwd'),
    sprintDir: absolutePath('/tmp/ralph/fake-sprint-dir'),
    progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
    model: 'test-model',
    plateauThreshold: 2,
    correctiveRetries: 2, // Stub git runner — these tests don't exercise the plateau fingerprint; a clean-tree
    // response keeps the post-spawn fingerprint call inert.
    gitRunner: {
      async run() {
        return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
      },
    },
    clock: () => FIXED_NOW,
    logger: noopLogger,
  });

  it('persists evaluator prompt.md under rounds/<N>/evaluator/', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = evaluatorLeaf(buildDeps(), task.id);

    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      // Generator leaf is responsible for stamping `currentRoundNum`; for this test we set
      // it directly (the evaluator reads it as input).
      currentRoundNum: 3,
      taskWorkspaceRoot: root.root,
    };

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);

    const promptPath = join(String(root.root), 'rounds', '3', 'evaluator', 'prompt.md');
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).toContain(task.name);
    expect(content).toContain('independent code reviewer');
  });

  it('writes prompt.md atomically — no .tmp leftover on the target dir', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = evaluatorLeaf(buildDeps(), task.id);
    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      currentRoundNum: 1,
      taskWorkspaceRoot: root.root,
    };
    await leaf.execute(ctx);

    const dir = join(String(root.root), 'rounds', '1', 'evaluator');
    const entries = await fs.readdir(dir);
    expect(entries).toContain('prompt.md');
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });

  it('uses the configured evaluator model regardless of task.escalatedToModel — escalation never touches the evaluator role', async () => {
    const initial = makeInProgressTaskWithRunningAttempt();
    const stamped = recordTaskEscalation(initial, 'claude-sonnet-4-6', 'claude-opus-4-8');
    if (!stamped.ok) throw stamped.error;
    const task = stamped.value;
    const deps = buildDeps();
    const leaf = evaluatorLeaf({ ...deps, model: 'evaluator-model-fixed' }, task.id);
    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      currentRoundNum: 1,
      taskWorkspaceRoot: root.root,
    };
    await leaf.execute(ctx);
    expect(deps.provider.recordedSessions[0]?.model).toBe('evaluator-model-fixed');
  });

  it('uses task.escalatedToEvaluatorEffort as the spawn effort when the task carries an evaluator effort escalation', async () => {
    // Evaluator lockstep effort bump: the model is unchanged (no escalatedToModel), but the raised
    // effort must reach the spawn. Without the leaf preferring `escalatedToEvaluatorEffort`, the
    // bump the escalation policy granted would never take effect.
    const initial = makeInProgressTaskWithRunningAttempt();
    const stamped = recordTaskEvaluatorEffortEscalation(initial, 'high');
    if (!stamped.ok) throw stamped.error;
    const task = stamped.value;
    const deps = buildDeps();
    const leaf = evaluatorLeaf({ ...deps, model: 'evaluator-model-fixed', effort: 'medium' }, task.id);
    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      currentRoundNum: 1,
      taskWorkspaceRoot: root.root,
    };
    await leaf.execute(ctx);
    expect(deps.provider.recordedSessions[0]?.effort).toBe('high');
    // Model stays the configured value — the effort rung never touches the evaluator model.
    expect(deps.provider.recordedSessions[0]?.model).toBe('evaluator-model-fixed');
  });

  it('falls back to the configured evaluator effort when the task has no escalatedToEvaluatorEffort', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const deps = buildDeps();
    const leaf = evaluatorLeaf({ ...deps, model: 'evaluator-model-fixed', effort: 'medium' }, task.id);
    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      currentRoundNum: 1,
      taskWorkspaceRoot: root.root,
    };
    await leaf.execute(ctx);
    expect(deps.provider.recordedSessions[0]?.effort).toBe('medium');
  });

  // Abort wire (keystone for #1/#5): the evaluator, like the generator, must carry the chain's
  // abort signal onto the spawned session so a TUI cancel mid-spawn kills the child via the
  // provider's SIGTERM ladder rather than letting it run to natural completion.
  it('threads the chain abort signal onto the spawned session so a cancel can kill the child', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const deps = buildDeps();
    const leaf = evaluatorLeaf(deps, task.id);
    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      currentRoundNum: 1,
      taskWorkspaceRoot: root.root,
    };
    const controller = new AbortController();
    const result = await leaf.execute(ctx, controller.signal);
    expect(result.ok).toBe(true);
    expect(deps.provider.recordedSessions[0]?.abortSignal).toBe(controller.signal);
  });

  // Prompt selection by session continuity — mirrors the generator leaf. The FIRST evaluator
  // turn of a session thread re-sends the full specification + rubric; a RESUMED turn sends the
  // slim continuation prompt. A provider that never reports a session id always gets the full
  // prompt because the discriminant — `priorEvaluatorSessionId` — is the same field `--resume`
  // consumes.
  describe('prompt selection by session continuity', () => {
    const PASSING_EVAL: readonly HarnessSignal[] = [
      {
        type: 'evaluation',
        status: 'passed',
        dimensions: [
          { dimension: 'correctness', passed: true, finding: 'all good' },
          { dimension: 'completeness', passed: true, finding: 'all steps shipped' },
          { dimension: 'safety', passed: true, finding: 'inputs validated' },
          { dimension: 'consistency', passed: true, finding: 'matches siblings' },
        ],
        timestamp: FIXED_NOW,
      },
    ];

    const readPrompt = (round: number): Promise<string> =>
      fs.readFile(join(String(root.root), 'rounds', String(round), 'evaluator', 'prompt.md'), 'utf8');

    const baseCtx = (
      task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>,
      roundNum: number
    ): ImplementCtx => ({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      currentRoundNum: roundNum,
      taskWorkspaceRoot: root.root,
    });

    it('sends the FULL evaluate prompt on the first turn (no prior session id)', async () => {
      const task = makeInProgressTaskWithRunningAttempt();
      const leaf = evaluatorLeaf(buildDeps(), task.id);
      const result = await leaf.execute(baseCtx(task, 1));
      expect(result.ok).toBe(true);

      const content = await readPrompt(1);
      expect(content).toContain('independent code reviewer');
      expect(content).not.toContain('# Re-evaluate — Round');
    });

    it('sends the CONTINUATION prompt on a resumed turn (prior session id present)', async () => {
      const provider = createFakeAiProvider({
        responses: { evaluate: '', 'evaluate-continuation': '' },
        signals: { evaluate: PASSING_EVAL, 'evaluate-continuation': PASSING_EVAL },
        sessionIds: { evaluate: 'eval-1' },
      });
      const task = makeInProgressTaskWithRunningAttempt();
      const leaf = evaluatorLeaf({ ...buildDeps(), provider }, task.id);

      const first = await leaf.execute(baseCtx(task, 1));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.ctx.priorEvaluatorSessionId).toBe('eval-1');
      expect(await readPrompt(1)).toContain('independent code reviewer');

      await fs.mkdir(join(String(root.root), 'rounds', '2', 'evaluator'), { recursive: true });
      const second = await leaf.execute({ ...first.value.ctx, currentRoundNum: 2 });
      expect(second.ok).toBe(true);

      const round2 = await readPrompt(2);
      expect(round2).toContain('# Re-evaluate — Round 2');
      expect(round2).not.toContain('## Review protocol'); // a heading unique to the full template
    });

    it('always sends the FULL prompt when the provider never reports a session id', async () => {
      const task = makeInProgressTaskWithRunningAttempt();
      const deps = buildDeps(); // no sessionIds configured
      const leaf = evaluatorLeaf(deps, task.id);

      const first = await leaf.execute(baseCtx(task, 1));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.ctx.priorEvaluatorSessionId).toBeUndefined();

      await fs.mkdir(join(String(root.root), 'rounds', '2', 'evaluator'), { recursive: true });
      const second = await leaf.execute({ ...first.value.ctx, currentRoundNum: 2 });
      expect(second.ok).toBe(true);

      expect(await readPrompt(1)).toContain('independent code reviewer');
      expect(await readPrompt(2)).toContain('independent code reviewer');
      expect(await readPrompt(2)).not.toContain('# Re-evaluate — Round');
    });
  });

  // `{{PROJECT_TOOLING}}` naming (research-quickwins): mirrors the generator leaf's equivalent
  // block — the FULL evaluate prompt threads the same bound agent-definition name + this flow's
  // installed skills so the evaluator sees explicitly-named tooling instead of the template's
  // default "(none detected)" fallback.
  describe('project tooling catalog', () => {
    const fakeSkillSource = (): SkillSource => ({
      getForFlow: async () =>
        Result.ok([
          {
            name: 'alignment',
            description: 'Confirm scope before diving into work',
            content: '# alignment\n',
          },
        ]),
      getByName: async () => Result.ok(undefined),
    });

    const baseCtx = (task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>): ImplementCtx => ({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      currentRoundNum: 1,
      taskWorkspaceRoot: root.root,
    });

    it('names the bound agent definition and installed skills in the FULL prompt', async () => {
      const task = makeInProgressTaskWithRunningAttempt();
      const leaf = evaluatorLeaf(
        { ...buildDeps(), agentDefinitionName: 'code-reviewer', skillSource: fakeSkillSource() },
        task.id
      );
      const result = await leaf.execute(baseCtx(task));
      expect(result.ok).toBe(true);

      const content = await fs.readFile(join(String(root.root), 'rounds', '1', 'evaluator', 'prompt.md'), 'utf8');
      expect(content).toContain('- Subagent: `code-reviewer`');
      expect(content).toContain('- Skill: `alignment` — Confirm scope before diving into work');
      expect(content).not.toContain('(none detected)');
    });

    it('falls back to the template default when neither an agent definition nor skills are available', async () => {
      const task = makeInProgressTaskWithRunningAttempt();
      const leaf = evaluatorLeaf({ ...buildDeps(), skillSource: emptySkillSource }, task.id);
      const result = await leaf.execute(baseCtx(task));
      expect(result.ok).toBe(true);

      const content = await fs.readFile(join(String(root.root), 'rounds', '1', 'evaluator', 'prompt.md'), 'utf8');
      expect(content).toContain('(none detected)');
      expect(content).not.toContain('- Subagent:');
      expect(content).not.toContain('- Skill:');
    });
  });

  // Reproduction-first (read side) — mirrors the generator leaf's equivalent block, built from
  // the SAME `ctx.reproductionArtifact`. Rides every round (not just round 1): the evaluator's
  // re-run instruction is an extension of its verification-tampering check on every turn.
  describe('reproduction section', () => {
    const reproductionArtifact: ImplementCtx['reproductionArtifact'] = {
      testPath: 'tests/unit/foo.test.ts',
      runCommand: 'npx vitest run tests/unit/foo.test.ts',
      observedFailure: 'AssertionError: expected 200 to equal 404',
      relevantTests: ['tests/unit/bar.test.ts'],
      checksum: 'deadbeef',
    };

    const baseCtx = (
      task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>,
      roundNum: number
    ): ImplementCtx => ({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      currentRoundNum: roundNum,
      taskWorkspaceRoot: root.root,
    });

    it('omits the section when ctx.reproductionArtifact is absent (non-defect-shaped task)', async () => {
      const task = makeInProgressTaskWithRunningAttempt();
      const leaf = evaluatorLeaf(buildDeps(), task.id);
      const result = await leaf.execute(baseCtx(task, 1));
      expect(result.ok).toBe(true);

      // The template's static tampering-check prose references the `<reproduction>` tag NAME by
      // name even when the block itself is empty (`` `<reproduction>` `` in backticks) — assert
      // on the wrapper's distinctive framing sentence instead of the bare tag substring.
      const content = await fs.readFile(join(String(root.root), 'rounds', '1', 'evaluator', 'prompt.md'), 'utf8');
      expect(content).not.toContain('Re-run this reproduction command yourself');
    });

    it('renders the validated reproduction, with the re-run instruction, into the FULL prompt', async () => {
      const task = makeInProgressTaskWithRunningAttempt();
      const leaf = evaluatorLeaf(buildDeps(), task.id);
      const result = await leaf.execute({ ...baseCtx(task, 1), reproductionArtifact });
      expect(result.ok).toBe(true);

      const content = await fs.readFile(join(String(root.root), 'rounds', '1', 'evaluator', 'prompt.md'), 'utf8');
      expect(content).toContain('<reproduction>');
      expect(content).toContain('Re-run this reproduction command yourself');
      expect(content).toContain('tests/unit/foo.test.ts');
      expect(content).toContain('AssertionError: expected 200 to equal 404');
    });

    it('also renders the reproduction into the CONTINUATION prompt (round 2+)', async () => {
      const provider = createFakeAiProvider({
        responses: { evaluate: '', 'evaluate-continuation': '' },
        signals: {
          evaluate: [
            {
              type: 'evaluation',
              status: 'passed',
              dimensions: [
                { dimension: 'correctness', passed: true, finding: 'all good' },
                { dimension: 'completeness', passed: true, finding: 'all steps shipped' },
                { dimension: 'safety', passed: true, finding: 'inputs validated' },
                { dimension: 'consistency', passed: true, finding: 'matches siblings' },
              ],
              timestamp: FIXED_NOW,
            },
          ],
          'evaluate-continuation': [
            {
              type: 'evaluation',
              status: 'passed',
              dimensions: [
                { dimension: 'correctness', passed: true, finding: 'all good' },
                { dimension: 'completeness', passed: true, finding: 'all steps shipped' },
                { dimension: 'safety', passed: true, finding: 'inputs validated' },
                { dimension: 'consistency', passed: true, finding: 'matches siblings' },
              ],
              timestamp: FIXED_NOW,
            },
          ],
        },
        sessionIds: { evaluate: 'eval-1' },
      });
      const task = makeInProgressTaskWithRunningAttempt();
      const leaf = evaluatorLeaf({ ...buildDeps(), provider }, task.id);

      const first = await leaf.execute({ ...baseCtx(task, 1), reproductionArtifact });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      await fs.mkdir(join(String(root.root), 'rounds', '2', 'evaluator'), { recursive: true });
      const second = await leaf.execute({ ...first.value.ctx, currentRoundNum: 2 });
      expect(second.ok).toBe(true);

      const round2 = await fs.readFile(join(String(root.root), 'rounds', '2', 'evaluator', 'prompt.md'), 'utf8');
      expect(round2).toContain('# Re-evaluate — Round 2');
      expect(round2).toContain('<reproduction>');
      expect(round2).toContain('tests/unit/foo.test.ts');
    });

    // Checksum wiring (minors[1]/[7]/[10]): the evaluator is the ONE role that re-checksums the
    // reproduction test at prompt-build time against `ReproductionArtifact.checksum` — a mismatch
    // (an unexplained edit, or a deletion) appends a bounded tampering note to the SAME
    // `<reproduction>` section the template's tampering-detection rule already audits.
    describe('checksum re-verification', () => {
      const REPRO_CONTENT = "describe('repro', () => { it('fails', () => { expect(200).toBe(404); }); });\n";

      const buildRealCwdDeps = async () => {
        const cwd = absolutePath(join(String(root.root), 'repo'));
        await fs.mkdir(String(cwd), { recursive: true });
        return { ...buildDeps(), cwd };
      };

      const writeReproFile = async (cwd: string, content: string): Promise<void> => {
        const full = join(cwd, 'tests/unit/foo.test.ts');
        await fs.mkdir(join(full, '..'), { recursive: true });
        await fs.writeFile(full, content, 'utf8');
      };

      it('checksum matches the file on disk → prompt carries the reproduction body WITHOUT a tamper note', async () => {
        const deps = await buildRealCwdDeps();
        await writeReproFile(String(deps.cwd), REPRO_CONTENT);
        const artifact: ImplementCtx['reproductionArtifact'] = {
          ...reproductionArtifact,
          checksum: createHash('sha256').update(REPRO_CONTENT, 'utf-8').digest('hex'),
        };
        const task = makeInProgressTaskWithRunningAttempt();
        const leaf = evaluatorLeaf(deps, task.id);
        const result = await leaf.execute({ ...baseCtx(task, 1), reproductionArtifact: artifact });
        expect(result.ok).toBe(true);

        const content = await fs.readFile(join(String(root.root), 'rounds', '1', 'evaluator', 'prompt.md'), 'utf8');
        expect(content).toContain('tests/unit/foo.test.ts');
        expect(content).not.toContain('TAMPERING CHECK');
      });

      it('checksum mismatch (file edited since validation) → prompt carries a bounded tamper note', async () => {
        const deps = await buildRealCwdDeps();
        // The file on disk no longer matches the checksum captured when the artifact was
        // validated — simulates a generator turn rewriting the reproduction test mid-loop.
        await writeReproFile(String(deps.cwd), 'expect(true).toBe(true); // edited to force green');
        const artifact: ImplementCtx['reproductionArtifact'] = {
          ...reproductionArtifact,
          checksum: createHash('sha256').update(REPRO_CONTENT, 'utf-8').digest('hex'),
        };
        const task = makeInProgressTaskWithRunningAttempt();
        const leaf = evaluatorLeaf(deps, task.id);
        const result = await leaf.execute({ ...baseCtx(task, 1), reproductionArtifact: artifact });
        expect(result.ok).toBe(true);

        const content = await fs.readFile(join(String(root.root), 'rounds', '1', 'evaluator', 'prompt.md'), 'utf8');
        // The reproduction body still rides — the note is APPENDED, not a replacement.
        expect(content).toContain('tests/unit/foo.test.ts');
        expect(content).toContain('TAMPERING CHECK');
        expect(content).toContain('needs an explicit, justified explanation');
      });

      it('checksum mismatch (file missing) → prompt carries the tamper note too (at least as suspicious as an edit)', async () => {
        const deps = await buildRealCwdDeps();
        // Deliberately never write the reproduction test file.
        const artifact: ImplementCtx['reproductionArtifact'] = {
          ...reproductionArtifact,
          checksum: createHash('sha256').update(REPRO_CONTENT, 'utf-8').digest('hex'),
        };
        const task = makeInProgressTaskWithRunningAttempt();
        const leaf = evaluatorLeaf(deps, task.id);
        const result = await leaf.execute({ ...baseCtx(task, 1), reproductionArtifact: artifact });
        expect(result.ok).toBe(true);

        const content = await fs.readFile(join(String(root.root), 'rounds', '1', 'evaluator', 'prompt.md'), 'utf8');
        expect(content).toContain('TAMPERING CHECK');
      });
    });
  });
});
