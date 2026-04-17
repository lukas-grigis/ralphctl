import { z } from 'zod';

// Sprint statuses (one-way transitions: draft → active → closed)
export const SprintStatusSchema = z.enum(['draft', 'active', 'closed']);
export type SprintStatus = z.infer<typeof SprintStatusSchema>;

// Task statuses (kanban flow: todo → in_progress → done)
export const TaskStatusSchema = z.enum(['todo', 'in_progress', 'done']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// Requirement status for tickets (pending → approved)
export const RequirementStatusSchema = z.enum(['pending', 'approved']);
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>;

// Evaluation status for tasks. Distinct from `evaluated` (a boolean "did the
// evaluator run") so callers can tell a real failure from a malformed evaluator
// output (no signal AND no parseable dimension lines) or a loop that short-
// circuited because the critique didn't change across iterations ("plateau" —
// the evaluator keeps flagging the same set of failed dimensions; feeding more
// fix attempts to the generator is wasteful, so we stop and mark the task done).
export const EvaluationStatusSchema = z.enum(['passed', 'failed', 'malformed', 'plateau']);
export type EvaluationStatus = z.infer<typeof EvaluationStatusSchema>;

// UUID8 hex id — used for every internal FK (project, repo, ticket, task).
// Names/slugs stay display-only, so renames never break references.
const IdSchema = z.string().min(1);

// Repository schema — one repo inside a project.
// `id` is the stable FK; `name` and `path` are display/execution artefacts.
export const RepositorySchema = z.object({
  id: IdSchema, // UUID8, stable across renames
  name: z.string().min(1), // Auto-derived from basename(path)
  path: z.string().min(1), // Absolute path
  checkScript: z.string().optional(), // e.g., "pnpm install && pnpm typecheck && pnpm lint && pnpm test"
  checkTimeout: z.number().positive().optional(), // Per-repo timeout in ms (overrides RALPHCTL_SETUP_TIMEOUT_MS)
});
export type Repository = z.infer<typeof RepositorySchema>;

// Project schema — multi-repo project definition.
// `id` is the stable FK; `name` (slug) + `displayName` are cosmetic.
export const ProjectSchema = z.object({
  id: IdSchema,
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'Project name must be a slug (lowercase, numbers, hyphens only)'),
  displayName: z.string().min(1),
  repositories: z.array(RepositorySchema).min(1),
  description: z.string().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectsSchema = z.array(ProjectSchema);
export type Projects = z.infer<typeof ProjectsSchema>;

// Ticket schema — lives inside a sprint; inherits its project.
// `affectedRepoIds` narrows which repos from the sprint's project the ticket
// touches; it's set during planning. Empty/undefined = every repo.
export const TicketSchema = z.object({
  id: IdSchema, // UUID8
  title: z.string().min(1),
  description: z.string().optional(),
  link: z.url().optional(),
  affectedRepoIds: z.array(IdSchema).optional(), // Subset of sprint's project's repos
  requirementStatus: RequirementStatusSchema.default('pending'),
  requirements: z.string().optional(), // Set during sprint refine
});
export type Ticket = z.infer<typeof TicketSchema>;

// Task schema — concrete unit of work in one repo.
// `repoId` is the FK to the repo; the executor resolves the absolute path
// from the project graph at runtime.
export const TaskSchema = z.object({
  id: IdSchema, // UUID8
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(z.string()).default([]),
  verificationCriteria: z.array(z.string()).default([]),
  status: TaskStatusSchema.default('todo'),
  order: z.number().int().positive(),
  ticketId: IdSchema.optional(),
  blockedBy: z.array(IdSchema).default([]),
  repoId: IdSchema, // Required — resolves to an absolute path at runtime
  verified: z.boolean().default(false),
  verificationOutput: z.string().optional(),
  evaluated: z.boolean().default(false),
  evaluationOutput: z.string().optional(),
  evaluationStatus: EvaluationStatusSchema.optional(),
  evaluationFile: z.string().optional(),
  // Planner-emitted extra evaluator dimensions; floor-only when undefined.
  extraDimensions: z.array(z.string().min(1)).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TasksSchema = z.array(TaskSchema);
export type Tasks = z.infer<typeof TasksSchema>;

// Import task — CLI / planner input. `repoId` is required; planner must pick
// one of the sprint's project's repos.
export const ImportTaskSchema = z.object({
  id: z.string().optional(), // Local ID for referencing in blockedBy
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(z.string()).optional(),
  verificationCriteria: z.array(z.string()).optional(),
  ticketId: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
  repoId: IdSchema,
  extraDimensions: z.array(z.string().min(1)).optional(),
});
export type ImportTask = z.infer<typeof ImportTaskSchema>;

export const ImportTasksSchema = z.array(ImportTaskSchema);
export type ImportTasks = z.infer<typeof ImportTasksSchema>;

// Refined requirement schema (for requirements refinement output)
export const RefinedRequirementSchema = z.object({
  ref: z.string().min(1),
  requirements: z.string().min(1),
});
export type RefinedRequirement = z.infer<typeof RefinedRequirementSchema>;

export const RefinedRequirementsSchema = z.array(RefinedRequirementSchema);
export type RefinedRequirements = z.infer<typeof RefinedRequirementsSchema>;

// Ideate output schema (combined requirements + tasks from sprint ideate)
export const IdeateOutputSchema = z.object({
  requirements: z.string().min(1),
  tasks: ImportTasksSchema,
});
export type IdeateOutput = z.infer<typeof IdeateOutputSchema>;

// Sprint schema — scoped to one project.
// `checkRanAt` is keyed by repoId (was projectPath).
export const SprintSchema = z.object({
  id: z.string().regex(/^\d{8}-\d{6}-[a-z0-9-]+$/, 'Invalid sprint ID format'),
  name: z.string().min(1),
  projectId: IdSchema, // Every sprint belongs to exactly one project
  status: SprintStatusSchema.default('draft'),
  createdAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable().default(null),
  closedAt: z.iso.datetime().nullable().default(null),
  tickets: z.array(TicketSchema).default([]),
  checkRanAt: z.record(IdSchema, z.iso.datetime()).default({}),
  branch: z.string().nullable().default(null),
});
export type Sprint = z.infer<typeof SprintSchema>;

// AI provider enum
export const AiProviderSchema = z.enum(['claude', 'copilot']);
export type AiProvider = z.infer<typeof AiProviderSchema>;

// Config schema (root level configuration)
export const ConfigSchema = z.object({
  currentSprint: z.string().nullable().default(null),
  aiProvider: AiProviderSchema.nullable().default(null),
  editor: z.string().nullable().default(null),
  evaluationIterations: z.number().int().min(0).optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

// JSON-schema strings for the AI. Generated on demand from the Zod source of
// truth — no hand-maintained mirror files to drift. Consumed by the refine
// and plan prompts so the AI's output is constrained to what our parsers
// accept.
export function getRequirementsOutputJsonSchema(): string {
  return JSON.stringify(z.toJSONSchema(RefinedRequirementsSchema), null, 2);
}

export function getTaskImportJsonSchema(): string {
  return JSON.stringify(z.toJSONSchema(ImportTasksSchema), null, 2);
}
