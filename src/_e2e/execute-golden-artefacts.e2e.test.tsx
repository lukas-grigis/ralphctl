/**
 * E2E scenario — golden-path artefact assertions.
 *
 * Complements `golden-path.e2e.test.tsx` (which only asserts task status +
 * runner terminal state) with focused checks on the ARTEFACTS the execute
 * flow writes to disk. The existing test does NOT assert any of these:
 *
 *   1. `task.commitSha` — set on the Task aggregate after `commit-task` runs.
 *      Requires `external.uncommitted: true` so `hasUncommittedChanges()`
 *      returns true and the leaf calls `commitChanges()`.
 *
 *   2. `evaluations/<task-id>.md` — written by `FileSystemSignalHandler` when
 *      the evaluator produces an `EvaluationSignal`. The harness default uses
 *      `NoopSignalHandler`; this test overrides it with the real
 *      `FileSystemSignalHandler`. Also asserts that the per-dimension
 *      `(score N/5)` marker introduced in the G2 contract appears in the file.
 *
 *   3. `done-criteria.md` at the sprint root — written by the PLAN chain's
 *      `save-tasks` leaf and READ by the EXECUTE chain's `evaluate-task` leaf
 *      (via `readDoneCriteriaBullet`). This test pre-populates the file and
 *      asserts the execute chain completes cleanly, confirming the reader
 *      gracefully handles the file without crashing or blocking the task.
 *
 * Each assertion is a separate `it(...)` so a regression in one doesn't mask
 * the others.
 *
 * NOTE: does NOT modify `harness.tsx` (per the E3 brief).
 */
import { describe, it, expect } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { abs, makeApprovedTicket, makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import type { FakeExternalPort } from '@src/business/_test-fakes/fake-external-port.ts';
import { FakePromptPort } from '@src/application/_test-fakes/fake-prompt-port.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import { resolveStoragePaths } from '@src/integration/persistence/storage-paths.ts';
import { FileSystemSignalHandler } from '@src/integration/signals/file-system-handler.ts';
import { unitSlug } from '@src/integration/persistence/unit-slug.ts';
import { renderDoneCriteria } from '@src/application/chains/leaves/save-tasks.ts';
import { bootExecuteScenario } from './harness.tsx';

const CWD = abs('/tmp/e2e-artefacts');

const taskComplete: HarnessSignal = {
  type: 'task-complete',
  timestamp: '2026-05-04T10:00:00Z' as never,
};

// ── shared sprint builder ────────────────────────────────────────────────────

function makeArtefactSprint(slugSuffix: string) {
  const sprint0 = makeSprint({ slug: `art-${slugSuffix}` });
  const ticket = makeApprovedTicket();
  const withTicket = sprint0.addTicket(ticket);
  if (!withTicket.ok) throw new Error('precondition: addTicket');
  const activated = withTicket.value.activate(sprint0.createdAt);
  if (!activated.ok) throw new Error('precondition: activate');
  const branched = activated.value.setBranch('ralphctl/artefacts');
  if (!branched.ok) throw new Error('precondition: setBranch');
  return branched.value;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('e2e: execute golden-path artefacts', () => {
  // ── 1. commit-task produces a non-empty task.commitSha ───────────────────

  describe('commit-task', () => {
    it('records a non-empty commitSha on the task after the commit leaf runs', async () => {
      const sprint = makeArtefactSprint('commit');
      const task = makeTask({ name: 'commit-me', order: 1, projectPath: '/tmp/artefact-repo' });

      // `uncommitted: true` → hasUncommittedChanges() returns true on
      // BOTH the dirty-tree preflight (sprint-start) AND the commit-task leaf.
      // Queue "continue" on the dirty-tree select prompt so the sprint-start
      // preflight doesn't reject the run — the task still executes, and then
      // commit-task sees uncommitted changes and calls commitChanges().
      const promptPort = new FakePromptPort();
      promptPort.queueSelect('continue' satisfies 'continue'); // dirty-tree-preflight

      const harness = bootExecuteScenario({
        sprint,
        sprintTasks: [task],
        cwd: CWD,
        evaluationIterations: 0,
        external: { uncommitted: true },
        prompt: promptPort,
        aiSession: {
          outcomes: [{ kind: 'ok', result: { output: 'task done' } }],
        },
        signalParser: {
          results: [[taskComplete]],
        },
      });

      const terminal = await harness.waitForTerminal({ timeout: 6000 });
      expect(terminal).toBe('completed');

      // commitChanges() was called: external records the call.
      const ext = harness.deps.external as FakeExternalPort;
      expect(ext.commitChangesCalls).toHaveLength(1);
      expect(ext.commitChangesCalls[0]?.message).toMatch(/^task\(/);

      // The persisted task carries the SHA the fake returned.
      const persisted = await harness.deps.taskRepo.findById(sprint.id, task.id);
      if (!persisted.ok) throw new Error('taskRepo.findById failed');
      expect(persisted.value.commitSha).toBeDefined();
      expect(persisted.value.commitSha?.length).toBeGreaterThan(0);
      // FakeExternalPort default stub: 'fakecommit0001'.
      expect(persisted.value.commitSha).toMatch(/^fakecommit/);
    });
  });

  // ── 2. evaluations/<task-id>.md with (score N/5) markers ─────────────────

  describe('evaluation artefact', () => {
    it('writes evaluations/<task-id>.md with per-dimension (score N/5) markers', async () => {
      const sprint = makeArtefactSprint('eval');
      const task = makeTask({ name: 'eval-task', order: 1, projectPath: '/tmp/artefact-repo' });

      // Compute the expected file path the signal handler will write to.
      // FileSystemSignalHandler uses resolveStoragePaths() + unitSlug(taskId, taskName).
      const paths = resolveStoragePaths();
      const slug = unitSlug(String(task.id), task.name);
      const evalFilePath = join(String(paths.executionUnitDir(sprint.id, slug)), 'evaluation.md');

      // Ensure the parent directory exists so the handler can write.
      await mkdir(join(String(paths.executionUnitDir(sprint.id, slug))), { recursive: true });

      // Use the real FileSystemSignalHandler so the evaluation file lands on disk.
      const signalHandler = new FileSystemSignalHandler(paths);

      // Evaluation signal with numeric per-dimension score (G2 contract).
      const evalPassed: HarnessSignal = {
        type: 'evaluation',
        status: 'passed',
        dimensions: [{ dimension: 'correctness', score: 5, passed: true, finding: 'all checks pass' }],
        overallScore: 5,
        critique: 'implementation is exemplary',
        timestamp: '2026-05-04T10:00:00Z' as never,
      };

      // Spawn order: execute-task (1) → evaluator round (2).
      const harness = bootExecuteScenario({
        sprint,
        sprintTasks: [task],
        cwd: CWD,
        evaluationIterations: 1,
        external: { uncommitted: false },
        overrides: { signalHandler },
        aiSession: {
          outcomes: [
            { kind: 'ok', result: { output: 'task done', sessionId: 'sess-exec' } },
            { kind: 'ok', result: { output: 'eval round 1' } },
          ],
        },
        signalParser: {
          results: [[taskComplete], [evalPassed]],
        },
      });

      const terminal = await harness.waitForTerminal({ timeout: 8000 });
      expect(terminal).toBe('completed');

      // Task persisted as done with evaluationStatus = passed.
      const persisted = await harness.deps.taskRepo.findById(sprint.id, task.id);
      if (!persisted.ok) throw new Error('taskRepo.findById failed');
      expect(persisted.value.status).toBe('done');
      expect(persisted.value.evaluationStatus).toBe('passed');

      // The signal handler wrote the evaluation file.
      let evalBody: string;
      try {
        evalBody = await readFile(evalFilePath, 'utf-8');
      } catch {
        throw new Error(`evaluation file not found at ${evalFilePath}`);
      }

      // Per-dimension (score N/5) marker — the G2 contract.
      expect(evalBody).toContain('(score 5/5)');
      // Overall score line.
      expect(evalBody).toContain('Overall score: 5/5');
      // Status header.
      expect(evalBody).toContain('# Evaluation — passed');
    });
  });

  // ── 3. done-criteria.md pre-populated and execute chain reads it cleanly ──

  describe('done-criteria.md', () => {
    it('execute chain reads done-criteria.md without error when pre-populated by plan', async () => {
      const sprint = makeArtefactSprint('dc');
      const task = makeTask({ name: 'dc-task', order: 1, projectPath: '/tmp/artefact-repo' });

      // Replicate what the plan chain's save-tasks leaf writes.
      const paths = resolveStoragePaths();
      const criteriaPath = String(paths.doneCriteriaFile(sprint.id));
      await mkdir(String(paths.sprintDir(sprint.id)), { recursive: true });
      const criteriaBody = renderDoneCriteria([task]);
      await writeFile(criteriaPath, criteriaBody, { encoding: 'utf-8' });

      // Sanity: the file should contain the task's bullet.
      expect(criteriaBody).toContain(`\`${String(task.id)}\``);

      // Run execute with evaluations enabled so the per-task evaluate-task leaf
      // actually invokes readDoneCriteriaBullet against the file.
      const evalPassed: HarnessSignal = {
        type: 'evaluation',
        status: 'passed',
        dimensions: [],
        critique: 'looks good',
        timestamp: '2026-05-04T10:00:00Z' as never,
      };

      const harness = bootExecuteScenario({
        sprint,
        sprintTasks: [task],
        cwd: CWD,
        evaluationIterations: 1,
        external: { uncommitted: false },
        aiSession: {
          outcomes: [
            { kind: 'ok', result: { output: 'task done', sessionId: 'sess-dc' } },
            { kind: 'ok', result: { output: 'eval' } },
          ],
        },
        signalParser: {
          results: [[taskComplete], [evalPassed]],
        },
      });

      // If readDoneCriteriaBullet throws or causes an unhandled error, the
      // runner would settle as 'failed'. Asserting 'completed' proves the
      // execute chain consumed the file without crashing.
      const terminal = await harness.waitForTerminal({ timeout: 8000 });
      expect(terminal).toBe('completed');

      // Task reached 'done' — the evaluator loop ran and returned a clean verdict.
      const persisted = await harness.deps.taskRepo.findById(sprint.id, task.id);
      if (!persisted.ok) throw new Error('taskRepo.findById failed');
      expect(persisted.value.status).toBe('done');

      // done-criteria.md still exists at the sprint root and was not deleted
      // by the execute chain (it only reads, never writes or removes).
      const criteriaAfter = await readFile(criteriaPath, 'utf-8');
      expect(criteriaAfter).toBe(criteriaBody);
    });
  });
});
