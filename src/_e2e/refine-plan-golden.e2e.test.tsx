/**
 * E2E scenario — refine + plan golden path.
 *
 * Runs the refine chain and then the plan chain back-to-back against fully
 * wired (non-Ink) deps, using scripted AI outputs for determinism. No TUI
 * surface is mounted — the chains run directly against `createTestDeps`
 * (in-memory repos, no real filesystem, no real AI CLI). This keeps the
 * test hermetic while still exercising the real chain factories and every
 * leaf inside them.
 *
 * Test 1 — refine-flow happy path:
 *   - Draft sprint with 2 pending tickets.
 *   - FakeAiSessionPort returns one scripted output per ticket.
 *   - After the chain completes both tickets must have
 *     `requirementStatus === 'approved'`.
 *   - Trace step names are pinned to the documented order (the architectural
 *     fence that prevents silent step-order drift).
 *
 * Test 2 — plan-flow happy path (uses the post-refine sprint state):
 *   - Post-refine sprint (all tickets approved), single-repo project.
 *   - FakeAiSessionPort returns a scripted 3-task JSON with a linear
 *     dependency chain (task-a → task-b → task-c).
 *   - After the chain completes:
 *     - 3 tasks are persisted.
 *     - The dependency chain is correct.
 *     - sprint.affectedRepositories contains the repo path.
 *   - Trace step names are pinned.
 *
 * The `persist-repo-selection` leaf is exercised by strategy (a): the
 * project has only ONE repo, so the leaf short-circuits the checkbox prompt
 * and writes the single-repo path automatically. No fake prompt answers
 * are needed for the repo-selection step.
 *
 * The `confirm-replan` and `confirm-task-list` leaves are exercised without
 * any queued prompt answers because `interactive` is not passed to
 * `createPlanFlow` (defaults to false/undefined), so both leaves exit early
 * via `if (!input.interactive ...)`.
 */
import { describe, expect, it } from 'vitest';

import { makeApprovedTicket, makeProject, makeSprint, makeTicket } from '@src/application/_test-fakes/fixtures.ts';
import { createTestDeps } from '@src/application/_test-fakes/create-test-deps.ts';
import type { FakePromptBuilderPort } from '@src/business/_test-fakes/fake-prompt-builder-port.ts';
import { createRefineFlow } from '@src/application/chains/refine/refine-flow.ts';
import { createPlanFlow } from '@src/application/chains/plan/plan-flow.ts';

// ---------------------------------------------------------------------------
// Scripted AI output for the plan flow.
//
// The `validateTasksAgainstSprint` guard inside `PlanSprintTasksUseCase`
// requires every task's `projectPath` to match one of the sprint's
// `affectedRepositories`. `persist-repo-selection` writes the project's
// single repo path (`/tmp/demo-repo`, the `makeProject()` default) to
// `sprint.affectedRepositories` — so the tasks must use the same path.
//
// The three tasks form a linear dependency chain:
//   task-a  (no deps)
//   task-b  (blockedBy: task-a)
//   task-c  (blockedBy: task-b)
// ---------------------------------------------------------------------------
const PLAN_OUTPUT = `\`\`\`json
[
  {
    "id": "task-a",
    "name": "Alpha",
    "steps": ["do alpha"],
    "verificationCriteria": ["alpha done"],
    "order": 1,
    "projectPath": "/tmp/demo-repo"
  },
  {
    "id": "task-b",
    "name": "Beta",
    "steps": ["do beta"],
    "verificationCriteria": ["beta done"],
    "order": 2,
    "blockedBy": ["task-a"],
    "projectPath": "/tmp/demo-repo"
  },
  {
    "id": "task-c",
    "name": "Gamma",
    "steps": ["do gamma"],
    "verificationCriteria": ["gamma done"],
    "order": 3,
    "blockedBy": ["task-b"],
    "projectPath": "/tmp/demo-repo"
  }
]
\`\`\``;

describe('e2e: refine + plan golden path', () => {
  it('refine-flow: approves all tickets and pins the step trace', async () => {
    // --- Arrange ---------------------------------------------------------
    const sprint0 = makeSprint({ slug: 'refine-golden' });
    const ticket1 = makeTicket({ title: 'Ticket one' });
    const ticket2 = makeTicket({ title: 'Ticket two' });
    const withT1 = sprint0.addTicket(ticket1);
    if (!withT1.ok) throw new Error(`precondition: addTicket t1: ${withT1.error.message}`);
    const withT2 = withT1.value.addTicket(ticket2);
    if (!withT2.ok) throw new Error(`precondition: addTicket t2: ${withT2.error.message}`);
    const sprint = withT2.value;

    // One scripted AI output per ticket. The parser falls back to the raw
    // text as requirements when the output is not valid JSON (which is fine
    // for a test that just needs the ticket to reach `approved`).
    const deps = createTestDeps({
      sprints: [sprint],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'Requirements for ticket one: do the first thing' } },
          { kind: 'ok', result: { output: 'Requirements for ticket two: do the second thing' } },
        ],
      },
    });

    const flow = createRefineFlow(deps, {
      sprintId: sprint.id,
      pendingTickets: sprint.tickets,
    });

    // --- Act -------------------------------------------------------------
    const result = await flow.execute({ sprintId: sprint.id });

    // --- Assert ----------------------------------------------------------
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Pin the step trace. The per-ticket sub-chains are flattened into the
    // top-level trace by `Sequential`. Two tickets → two full sets of
    // per-ticket steps after `assert-draft`.
    const stepNames = result.value.trace.map((t) => t.stepName);
    expect(stepNames).toStrictEqual([
      'load-sprint',
      'assert-draft',
      // ticket 1 sub-chain
      'stage-ticket',
      'build-refinement-unit',
      'link-skills',
      'render-prompt-to-file',
      `refine-${ticket1.id}`,
      'unlink-skills',
      `save-after-${ticket1.id}`,
      'export-sprint-requirements',
      // ticket 2 sub-chain
      'stage-ticket',
      'build-refinement-unit',
      'link-skills',
      'render-prompt-to-file',
      `refine-${ticket2.id}`,
      'unlink-skills',
      `save-after-${ticket2.id}`,
      'export-sprint-requirements',
    ]);
    for (const entry of result.value.trace) {
      expect(entry.status).toBe('completed');
    }

    // Both tickets must be approved in the sprint repo.
    const reread = await deps.sprintRepo.findById(sprint.id);
    if (!reread.ok) throw new Error('expected sprint after run');
    for (const ticket of reread.value.tickets) {
      expect(ticket.requirementStatus).toBe('approved');
    }

    // The prompt builder was called once per ticket.
    const prompts = deps.prompts as FakePromptBuilderPort;
    expect(prompts.refineCalls).toHaveLength(2);
  });

  it('plan-flow: creates 3 tasks with linear dependency chain and persists repo selection', async () => {
    // --- Arrange ---------------------------------------------------------
    // Build a sprint where both tickets are already approved (mirrors the
    // post-refine state). Using `makeApprovedTicket()` for brevity instead
    // of running the refine chain a second time.
    const sprint0 = makeSprint({ slug: 'plan-golden' });
    const approved1 = makeApprovedTicket({ title: 'Alpha ticket', requirements: 'do alpha' });
    const approved2 = makeApprovedTicket({ title: 'Beta ticket', requirements: 'do beta' });
    const withT1 = sprint0.addTicket(approved1);
    if (!withT1.ok) throw new Error(`precondition: addTicket t1: ${withT1.error.message}`);
    const withT2 = withT1.value.addTicket(approved2);
    if (!withT2.ok) throw new Error(`precondition: addTicket t2: ${withT2.error.message}`);
    const sprint = withT2.value;

    // Single-repo project — `persist-repo-selection` will skip the checkbox
    // prompt and write the one repo's path automatically.
    const project = makeProject();

    const deps = createTestDeps({
      sprints: [sprint],
      projects: [project],
      aiSession: {
        outcomes: [{ kind: 'ok', result: { output: PLAN_OUTPUT } }],
      },
    });

    const flow = createPlanFlow(deps, { sprintId: sprint.id });

    // --- Act -------------------------------------------------------------
    const result = await flow.execute({ sprintId: sprint.id });

    // --- Assert ----------------------------------------------------------
    expect(result.ok).toBe(true);
    if (!result.ok) {
      // Expose the error for debugging if the assertion fires.
      throw new Error(`plan-flow failed: ${result.error.error.message}`);
    }

    // Pin the step trace (the architectural fence).
    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual([
      'load-sprint',
      'assert-draft',
      'assert-all-tickets-approved',
      'persist-repo-selection',
      'load-existing-tasks',
      'snapshot-existing-tasks',
      'build-planning-folder',
      'link-skills',
      'confirm-replan',
      'render-prompt-to-file',
      'plan-tasks',
      'reorder-tasks',
      'confirm-task-list',
      'save-tasks',
      'unlink-skills',
    ]);

    // --- 3 tasks were created --------------------------------------------
    const persisted = await deps.taskRepo.findBySprintId(sprint.id);
    if (!persisted.ok) throw new Error('taskRepo.findBySprintId failed');
    expect(persisted.value).toHaveLength(3);

    const byName = new Map(persisted.value.map((t) => [t.name, t]));
    const taskA = byName.get('Alpha');
    const taskB = byName.get('Beta');
    const taskC = byName.get('Gamma');
    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();
    expect(taskC).toBeDefined();

    // --- Linear dependency chain -----------------------------------------
    // taskA has no deps. taskB blocks on taskA. taskC blocks on taskB.
    expect(taskA?.blockedBy).toHaveLength(0);
    expect(taskB?.blockedBy).toHaveLength(1);
    expect(taskC?.blockedBy).toHaveLength(1);

    // The blockedBy ids must be real TaskIds (resolved from placeholders by
    // the parser). Verify cross-reference: taskB.blockedBy[0] === taskA.id.
    expect(String(taskB?.blockedBy[0])).toBe(String(taskA?.id));
    expect(String(taskC?.blockedBy[0])).toBe(String(taskB?.id));

    // --- affectedRepositories was persisted on the sprint ----------------
    const reread = await deps.sprintRepo.findById(sprint.id);
    if (!reread.ok) throw new Error('sprintRepo.findById failed');
    expect(reread.value.affectedRepositories).toHaveLength(1);
    expect(String(reread.value.affectedRepositories[0])).toBe('/tmp/demo-repo');

    // The prompt builder was called once for the plan prompt.
    const prompts = deps.prompts as FakePromptBuilderPort;
    expect(prompts.planCalls).toHaveLength(1);
    expect(prompts.planCalls[0]?.sprint.id).toStrictEqual(sprint.id);
  });
});
