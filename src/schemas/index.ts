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

// Repository schema (a single repository within a project)
export const RepositorySchema = z.object({
  name: z.string().min(1), // Auto-derived from basename(path)
  path: z.string().min(1), // Absolute path
  setupScript: z.string().optional(), // e.g., "npm install" or "pip install -e ."
  verifyScript: z.string().optional(), // e.g., "npm test" or "pytest"
});
export type Repository = z.infer<typeof RepositorySchema>;

// Project schema (multi-repo project definition)
export const ProjectSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'Project name must be a slug (lowercase, numbers, hyphens only)'),
  displayName: z.string().min(1),
  repositories: z.array(RepositorySchema).min(1),
  description: z.string().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

// Projects array schema
export const ProjectsSchema = z.array(ProjectSchema);
export type Projects = z.infer<typeof ProjectsSchema>;

// Ticket schema (ticket to be planned)
export const TicketSchema = z.object({
  id: z.string().min(1), // Internal UUID8 (auto-generated)
  externalId: z.string().optional(), // Optional external ID (e.g., JIRA-123)
  title: z.string().min(1),
  description: z.string().optional(),
  link: z.url().optional(),
  projectName: z.string().min(1), // References Project.name
  affectedRepositories: z.array(z.string()).optional(), // Repository paths selected during planning
  requirementStatus: RequirementStatusSchema.default('pending'),
  requirements: z.string().optional(), // Refined requirements (set during sprint refine)
});
export type Ticket = z.infer<typeof TicketSchema>;

// Task schema
export const TaskSchema = z.object({
  id: z.string().min(1), // UUID8
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(z.string()).default([]),
  status: TaskStatusSchema.default('todo'),
  order: z.number().int().positive(),
  ticketId: z.string().optional(), // References Ticket.id (internal)
  blockedBy: z.array(z.string()).default([]),
  projectPath: z.string().min(1), // Single path for execution
  verified: z.boolean().default(false), // Whether verification passed
  verificationOutput: z.string().optional(), // Output from verification run
});
export type Task = z.infer<typeof TaskSchema>;

// Tasks array schema
export const TasksSchema = z.array(TaskSchema);
export type Tasks = z.infer<typeof TasksSchema>;

// Import task schema (for task import from CLI or planning)
export const ImportTaskSchema = z.object({
  id: z.string().optional(), // Local ID for referencing in blockedBy
  name: z.string().min(1), // Required
  description: z.string().optional(),
  steps: z.array(z.string()).optional(),
  ticketId: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
  projectPath: z.string().min(1), // Required - execution directory
});
export type ImportTask = z.infer<typeof ImportTaskSchema>;

// Import tasks array schema
export const ImportTasksSchema = z.array(ImportTaskSchema);
export type ImportTasks = z.infer<typeof ImportTasksSchema>;

// Refined requirement schema (for requirements refinement output)
export const RefinedRequirementSchema = z.object({
  ref: z.string().min(1),
  requirements: z.string().min(1),
});
export type RefinedRequirement = z.infer<typeof RefinedRequirementSchema>;

// Refined requirements array schema
export const RefinedRequirementsSchema = z.array(RefinedRequirementSchema);
export type RefinedRequirements = z.infer<typeof RefinedRequirementsSchema>;

// Ideate output schema (combined requirements + tasks from sprint ideate)
export const IdeateOutputSchema = z.object({
  requirements: z.string().min(1),
  tasks: ImportTasksSchema,
});
export type IdeateOutput = z.infer<typeof IdeateOutputSchema>;

// Sprint schema (was Scope)
export const SprintSchema = z.object({
  id: z.string().regex(/^\d{8}-\d{6}-[a-z0-9-]+$/, 'Invalid sprint ID format'),
  name: z.string().min(1),
  status: SprintStatusSchema.default('draft'),
  createdAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable().default(null),
  closedAt: z.iso.datetime().nullable().default(null),
  tickets: z.array(TicketSchema).default([]),
});
export type Sprint = z.infer<typeof SprintSchema>;

// Config schema (root level configuration)
export const ConfigSchema = z.object({
  currentSprint: z.string().nullable().default(null),
});
export type Config = z.infer<typeof ConfigSchema>;
