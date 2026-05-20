import { Result } from '@src/domain/result.ts';
import type { TodoTask } from '@src/domain/entity/task.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { parseTaskList } from '@src/integration/ai/prompts/_engine/parse-task-list.ts';
import { PlanBlockedSchema } from '@src/integration/ai/prompts/_engine/task-import-schema.ts';

/**
 * Parse the JSON the AI writes after an interactive plan session. Pure — no I/O.
 *
 * Two acceptable top-level shapes:
 *
 *   - `[ TaskImportSpec, ... ]`         — task array (happy path); validated and resolved by
 *                                          {@link parseTaskList} in `'lookup'` mode.
 *   - `{ "blocked": "<reason>" }`        — the AI gave up; validated by
 *                                          {@link PlanBlockedSchema}, surfaced as
 *                                          {@link InvalidStateError} so the chain halts cleanly
 *                                          without writing tasks.
 */

export interface ParsePlanOutputInput {
  readonly project: Project;
  readonly sprint: Sprint;
}

export const parsePlanOutput = (
  raw: string,
  ctx: ParsePlanOutputInput
): Result<readonly TodoTask[], ParseError | InvalidStateError> => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    return Result.error(
      new ParseError({ subCode: 'invalid-json', message: 'plan: AI output is not valid JSON', cause })
    );
  }

  // Discriminator: an object (not an array) means the AI took the "blocked" escape hatch.
  if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
    const parsed = PlanBlockedSchema.safeParse(json);
    if (parsed.success) {
      return Result.error(
        new InvalidStateError({
          entity: 'plan',
          currentState: 'blocked',
          attemptedAction: 'plan',
          message: `plan: AI emitted blocked: ${parsed.data.blocked}`,
        })
      );
    }
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: 'plan: expected an array of task specs at top level (or `{ blocked: "<reason>" }`)',
      })
    );
  }

  const approvedTickets = ctx.sprint.tickets.filter((t) => t.status === 'approved');

  return parseTaskList(json, {
    project: ctx.project,
    mode: { kind: 'lookup', tickets: approvedTickets },
  });
};
