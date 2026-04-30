/**
 * Internal parser for the AI-emitted task list — shared between the plan
 * and ideate use cases. Lives in `usecases/plan/` because plan is the
 * primary owner; ideate imports `buildTasksFromEntries` for its own
 * `<tasks>`-block payload.
 *
 * Two entry points:
 *  - `parseTaskList(rawOutput)` — full parse: extract JSON from raw AI
 *    stdout (fenced or bare top-level array) and validate every entry.
 *  - `buildTasksFromEntries(entries)` — assumes the array is already
 *    extracted; validates and constructs `Task`s.
 *
 * No I/O, no logging — pure functions returning `Result`.
 */
import { Task } from '../../../domain/entities/task.ts';
import { ParseError } from '../../../domain/errors/parse-error.ts';
import { Result } from '../../../domain/result.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { TaskId } from '../../../domain/values/task-id.ts';
import { TicketId } from '../../../domain/values/ticket-id.ts';
import type { ValidationError } from '../../../domain/values/validation-error.ts';

/** Match the first JSON block — fenced ```json … ``` or a bare top-level array. */
const FENCED_JSON_REGEX = /```(?:json)?\s*([\s\S]*?)```/i;

/** Shape we expect each task entry in the AI output to have. */
interface RawTaskEntry {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly steps?: unknown;
  readonly verificationCriteria?: unknown;
  readonly order?: unknown;
  readonly ticketId?: unknown;
  readonly blockedBy?: unknown;
  readonly projectPath?: unknown;
  readonly extraDimensions?: unknown;
}

export function parseTaskList(rawOutput: string): Result<readonly Task[], ParseError | ValidationError> {
  const jsonText = extractJson(rawOutput);
  if (jsonText === null) {
    return Result.error(
      new ParseError({
        subCode: 'invalid-json',
        message: 'no JSON block found in AI output',
        hint: 'The AI did not emit a fenced JSON block. Re-run, or inspect the session log for what was returned.',
      })
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (cause) {
    return Result.error(
      new ParseError({
        subCode: 'invalid-json',
        message: 'AI output JSON could not be parsed',
        cause,
        hint: 'The AI emitted malformed JSON. Re-run; inspect the session log if it persists.',
      })
    );
  }

  if (!Array.isArray(parsed)) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: 'expected a JSON array of task entries',
      })
    );
  }

  return buildTasksFromEntries(parsed);
}

function extractJson(rawOutput: string): string | null {
  const fenced = FENCED_JSON_REGEX.exec(rawOutput);
  if (fenced?.[1]) return fenced[1].trim();
  const start = rawOutput.indexOf('[');
  const end = rawOutput.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  return rawOutput.slice(start, end + 1);
}

export function buildTasksFromEntries(
  entries: readonly unknown[]
): Result<readonly Task[], ParseError | ValidationError> {
  const tasks: Task[] = [];
  for (let i = 0; i < entries.length; i++) {
    const built = buildOneTask(entries[i], i);
    if (!built.ok) return Result.error(built.error);
    tasks.push(built.value);
  }
  return Result.ok(tasks);
}

function buildOneTask(entryUnknown: unknown, index: number): Result<Task, ParseError | ValidationError> {
  if (typeof entryUnknown !== 'object' || entryUnknown === null) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `task entry [${String(index)}] is not an object`,
      })
    );
  }
  const entry = entryUnknown as RawTaskEntry;

  const name = typeof entry.name === 'string' ? entry.name : '';
  if (name.length === 0) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `task entry [${String(index)}] is missing 'name'`,
      })
    );
  }

  const order = typeof entry.order === 'number' ? entry.order : NaN;

  const projectPathRaw = typeof entry.projectPath === 'string' ? entry.projectPath : '';
  if (projectPathRaw.length === 0) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `task entry [${String(index)}] is missing 'projectPath'`,
      })
    );
  }
  const projectPathResult = AbsolutePath.parse(projectPathRaw);
  if (!projectPathResult.ok) return Result.error(projectPathResult.error);

  const stepsResult = coerceStringArray(entry.steps, `task[${String(index)}].steps`);
  if (!stepsResult.ok) return Result.error(stepsResult.error);
  const verificationResult = coerceStringArray(
    entry.verificationCriteria,
    `task[${String(index)}].verificationCriteria`
  );
  if (!verificationResult.ok) return Result.error(verificationResult.error);

  let ticketId: TicketId | undefined;
  if (typeof entry.ticketId === 'string' && entry.ticketId.length > 0) {
    const r = TicketId.parse(entry.ticketId);
    if (!r.ok) return Result.error(r.error);
    ticketId = r.value;
  }

  const blockedByResult = parseBlockedBy(entry.blockedBy, index);
  if (!blockedByResult.ok) return Result.error(blockedByResult.error);

  let extraDimensions: readonly string[] | undefined;
  if (entry.extraDimensions !== undefined) {
    const r = coerceStringArray(entry.extraDimensions, `task[${String(index)}].extraDimensions`);
    if (!r.ok) return Result.error(r.error);
    extraDimensions = r.value;
  }

  const description = typeof entry.description === 'string' ? entry.description : undefined;

  return Task.create({
    name,
    ...(description !== undefined ? { description } : {}),
    steps: stepsResult.value,
    verificationCriteria: verificationResult.value,
    order,
    ...(ticketId !== undefined ? { ticketId } : {}),
    ...(blockedByResult.value !== undefined ? { blockedBy: blockedByResult.value } : {}),
    projectPath: projectPathResult.value,
    ...(extraDimensions !== undefined ? { extraDimensions } : {}),
  });
}

function parseBlockedBy(
  raw: unknown,
  index: number
): Result<readonly TaskId[] | undefined, ParseError | ValidationError> {
  if (raw === undefined) return Result.ok(undefined);
  if (!Array.isArray(raw)) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `task[${String(index)}].blockedBy must be an array`,
      })
    );
  }
  const ids: TaskId[] = [];
  for (const dep of raw) {
    if (typeof dep !== 'string') {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `task[${String(index)}].blockedBy contains a non-string entry`,
        })
      );
    }
    const r = TaskId.parse(dep);
    if (!r.ok) return Result.error(r.error);
    ids.push(r.value);
  }
  return Result.ok(ids);
}

function coerceStringArray(raw: unknown, field: string): Result<readonly string[], ParseError> {
  if (raw === undefined) return Result.ok([]);
  if (!Array.isArray(raw)) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `${field} must be an array of strings`,
      })
    );
  }
  for (const item of raw) {
    if (typeof item !== 'string') {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `${field} contains a non-string entry`,
        })
      );
    }
  }
  return Result.ok([...(raw as readonly string[])]);
}
