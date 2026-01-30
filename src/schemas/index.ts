import { z } from 'zod';

// Scope statuses (one-way transitions: draft → active → closed)
export const ScopeStatusSchema = z.enum(['draft', 'active', 'closed']);
export type ScopeStatus = z.infer<typeof ScopeStatusSchema>;

// Task statuses (kanban flow: todo → in_progress → testing → done)
export const TaskStatusSchema = z.enum(['todo', 'in_progress', 'testing', 'done']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// Ticket schema (external issue reference)
export const TicketSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  link: z.string().url().optional(),
});
export type Ticket = z.infer<typeof TicketSchema>;

// Task schema
export const TaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(z.string()).default([]),
  status: TaskStatusSchema.default('todo'),
  order: z.number().int().positive(),
  ticketId: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// Tasks array schema
export const TasksSchema = z.array(TaskSchema);
export type Tasks = z.infer<typeof TasksSchema>;

// Scope schema
export const ScopeSchema = z.object({
  id: z.string().regex(/^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/, 'Invalid scope ID format'),
  name: z.string().min(1),
  status: ScopeStatusSchema.default('draft'),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable().default(null),
  closedAt: z.string().datetime().nullable().default(null),
  tickets: z.array(TicketSchema).default([]),
});
export type Scope = z.infer<typeof ScopeSchema>;

// Config schema (root level configuration)
export const ConfigSchema = z.object({
  activeScope: z.string().nullable().default(null),
});
export type Config = z.infer<typeof ConfigSchema>;

// Validation helpers
export function validateScope(data: unknown): Scope {
  return ScopeSchema.parse(data);
}

export function validateTasks(data: unknown): Tasks {
  return TasksSchema.parse(data);
}

export function validateConfig(data: unknown): Config {
  return ConfigSchema.parse(data);
}
