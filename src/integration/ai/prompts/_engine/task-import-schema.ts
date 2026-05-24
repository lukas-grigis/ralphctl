import { z } from 'zod';

/**
 * Zod schemas for the JSON shapes the AI writes after an ideate or plan-interactive session.
 * Single source of truth: the prompt's `{{SCHEMA}}` placeholder is derived from these via
 * {@link zodToJsonSchema}, and the parsers (`parseIdeateOutput`, `parsePlanOutput`,
 * `parseTaskList`) validate against the same shapes. No drift between what the AI is told to
 * produce and what the harness accepts.
 *
 * Domain-aware checks (projectPath → known repository, ticketRef → approved ticket id,
 * blockedBy → known task id) live in `parseTaskList` because they need access to project /
 * sprint state — they're not pure shape validation. Zod handles structure; code handles
 * cross-references.
 */

/**
 * One verification criterion entry the AI emits. Mirrors the domain
 * `VerificationCriterion`:
 *
 *  - `id` is stable within the task (`C1`, `C2`, …); the evaluator cites it verbatim.
 *  - `assertion` is the human-readable check.
 *  - `check === 'auto'` REQUIRES `command` — the evaluator runs it and records the verbatim
 *    output as `executionEvidence` on the matching dimension.
 *  - `check === 'manual'` MUST omit `command` — the evaluator cites a code location instead.
 *
 * Bare strings are no longer accepted from the AI; legacy on-disk shapes are normalised at
 * read time by the persistence-layer schema (`task.schema.ts`), not here.
 */
export const VerificationCriterionImportSchema = z
  .object({
    id: z.string().min(1, 'criterion.id missing or empty'),
    assertion: z.string().min(1, 'criterion.assertion missing or empty'),
    check: z.union([z.literal('auto'), z.literal('manual')]),
    command: z.string().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.check === 'auto') {
      if (c.command === undefined || c.command.trim().length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `criterion '${c.id}' is auto but has no command`,
          path: ['command'],
        });
      }
    } else if (c.command !== undefined && c.command.trim().length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `criterion '${c.id}' is manual but carries a command`,
        path: ['command'],
      });
    }
  });

/**
 * One entry in the AI's task array. `name`, `projectPath`, `steps`, and `verificationCriteria`
 * are required; `id`, `description`, `ticketRef`, and `blockedBy` are optional. Empty strings
 * inside required arrays are rejected — empty steps are a usage error, not a corner case.
 */
export const TaskImportSpecSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1, 'name missing or empty'),
    description: z.string().optional(),
    projectPath: z.string().min(1, 'projectPath missing'),
    ticketRef: z.string().optional(),
    steps: z.array(z.string().min(1)).min(1, 'steps missing or empty'),
    verificationCriteria: z.array(VerificationCriterionImportSchema).min(1, 'verificationCriteria missing or empty'),
    blockedBy: z.array(z.string()).optional(),
    /**
     * Per-task evaluator dimensions to score in ADDITION to the four floor dimensions
     * (correctness, completeness, safety, consistency). Optional; the planner omits the field
     * when the floor dimensions already capture what matters. Capped at 6 to keep the rubric
     * focused — past that, dimensions tend to overlap and dilute the per-axis verdict.
     */
    extraDimensions: z.array(z.string().min(1)).max(6).optional(),
  })
  .strict();

export type TaskImportSpec = z.infer<typeof TaskImportSpecSchema>;

/** Bare task array — used when the AI writes only tasks (plan-interactive happy path). */
export const TaskImportListSchema = z.array(TaskImportSpecSchema);

/**
 * Top-level shape the ideate session writes: requirements text plus the tasks generated from
 * those requirements. Single object envelope so the harness can split the two artefacts in one
 * read.
 */
export const IdeateOutputSchema = z
  .object({
    requirements: z.string().min(1, 'requirements missing or empty'),
    tasks: TaskImportListSchema,
  })
  .strict();

/**
 * Top-level shape the plan-interactive session writes. Either a task array (happy path) or an
 * `{ blocked: "<reason>" }` object (the AI declined to plan). Discriminator is "is it an array?"
 * — see the parser in `plan-output.ts` for the runtime branch.
 */
export const PlanBlockedSchema = z
  .object({
    blocked: z.string().min(1, 'blocked reason missing or empty'),
  })
  .strict();

/**
 * JSON Schema string substituted into prompts at the `{{SCHEMA}}` placeholder. Derived from
 * {@link TaskImportListSchema} via zod's built-in {@link z.toJSONSchema} so the AI always sees
 * what the parser actually accepts.
 */
export const TASK_IMPORT_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(TaskImportListSchema), null, 2);
