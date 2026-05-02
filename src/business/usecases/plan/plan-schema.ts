/**
 * JSON schema the AI is told to write its task-list output against.
 * Substituted as `{{SCHEMA}}` in plan-interactive.md / plan-auto.md.
 *
 * Mirrors the shape `parseTaskList` accepts (see `task-list-parser.ts`).
 * Hand-authored — the parser is the source of truth for what we accept;
 * this string just describes that contract to the AI.
 */
export const TASK_IMPORT_JSON_SCHEMA = JSON.stringify(
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'PlannedTasks',
    description: 'Task-list output the planner writes for sprint execution',
    type: 'array',
    items: {
      type: 'object',
      required: ['name', 'projectPath'],
      properties: {
        id: {
          type: 'string',
          description: 'Optional stable identifier the planner can pick. The harness mints one when absent.',
        },
        name: {
          type: 'string',
          minLength: 1,
          description: 'Short imperative title — what this task accomplishes.',
        },
        description: {
          type: 'string',
          description: 'Optional longer-form explanation. Keep AC + scope in steps / verificationCriteria.',
        },
        steps: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Concrete implementation steps, in order.',
        },
        verificationCriteria: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Observable checks an evaluator can run to confirm completion.',
        },
        order: {
          type: 'integer',
          minimum: 1,
          description: '1-indexed execution order — the harness reorders by dependencies after import.',
        },
        ticketId: {
          type: 'string',
          description: 'The ticket this task descends from (matches Ticket.id).',
        },
        blockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids of other tasks that must complete before this one starts.',
        },
        projectPath: {
          type: 'string',
          minLength: 1,
          description: 'Absolute repository path the task executes in. Must be one of the repos the user selected.',
        },
        extraDimensions: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description:
            'Optional extra evaluation dimensions beyond the floor (Correctness / Completeness / Safety / Consistency). Each becomes a graded block in the evaluator prompt.',
        },
      },
    },
  },
  null,
  2
);
