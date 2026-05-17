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
    verificationCriteria: z.array(z.string().min(1)).min(1, 'verificationCriteria missing or empty'),
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

export type IdeateOutput = z.infer<typeof IdeateOutputSchema>;

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

export type PlanBlocked = z.infer<typeof PlanBlockedSchema>;

/**
 * JSON Schema string substituted into prompts at the `{{SCHEMA}}` placeholder. Derived from
 * {@link TaskImportListSchema} via zod's built-in {@link z.toJSONSchema} so the AI always sees
 * what the parser actually accepts.
 */
export const TASK_IMPORT_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(TaskImportListSchema), null, 2);
