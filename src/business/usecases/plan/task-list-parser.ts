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
 * Two-pass construction so the AI can use arbitrary placeholder strings
 * (`"1"`, `"auth-setup"`) for `id` and reference them in `blockedBy`:
 *
 *  1. Pre-allocate a real {@link TaskId} for every entry. If the entry has
 *     a non-empty string `id`, record `placeholder → realTaskId`. Duplicate
 *     placeholders are a parse error.
 *  2. Build each `Task` with its pre-allocated id and resolve every
 *     `blockedBy` reference via the placeholder map. Unknown placeholder
 *     references and self-references are parse errors.
 *
 * Entries without an `id` field still get a real TaskId — they just can't
 * be referenced by other tasks.
 *
 * No I/O, no logging — pure functions returning `Result`.
 */
import { Task } from '@src/domain/entities/task.ts';
import { ParseError } from '@src/domain/errors/parse-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { TaskId } from '@src/domain/values/task-id.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';
import type { ValidationError } from '@src/domain/values/validation-error.ts';

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
  // Pass 1 — pre-allocate a real TaskId for every entry and build the
  // placeholder map. The AI's `id` field is just a local label used by
  // `blockedBy`; the harness owns the real ids.
  const allocated: { readonly entry: RawTaskEntry; readonly id: TaskId; readonly placeholder: string | null }[] = [];
  const placeholderMap = new Map<string, TaskId>();

  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i];
    if (typeof raw !== 'object' || raw === null) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `task entry [${String(i)}] is not an object`,
        })
      );
    }
    const entry = raw as RawTaskEntry;
    const placeholder = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : null;

    if (placeholder !== null && placeholderMap.has(placeholder)) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `duplicate placeholder id '${placeholder}' at task[${String(i)}]`,
          hint: "Each task's `id` must be unique within the array — it's used only to resolve `blockedBy` references.",
        })
      );
    }

    const taskId = TaskId.generate();
    if (placeholder !== null) {
      placeholderMap.set(placeholder, taskId);
    }
    allocated.push({ entry, id: taskId, placeholder });
  }

  // Pass 2 — build each Task with its pre-allocated id and resolve
  // `blockedBy` placeholders.
  const tasks: Task[] = [];
  for (let i = 0; i < allocated.length; i++) {
    const slot = allocated[i];
    if (slot === undefined) continue;
    const built = buildOneTask(slot.entry, i, slot.id, slot.placeholder, placeholderMap);
    if (!built.ok) return Result.error(built.error);
    tasks.push(built.value);
  }
  return Result.ok(tasks);
}

function buildOneTask(
  entry: RawTaskEntry,
  index: number,
  id: TaskId,
  placeholder: string | null,
  placeholderMap: ReadonlyMap<string, TaskId>
): Result<Task, ParseError | ValidationError> {
  const name = typeof entry.name === 'string' ? entry.name : '';
  if (name.length === 0) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `task entry [${String(index)}] is missing 'name'`,
      })
    );
  }

  // The AI is told to use `blockedBy` for dependency ordering — the
  // prompt never asks for `order`. Default to the array position (1-
  // indexed) when missing or invalid; the dependency-reorder leaf that
  // runs next is the canonical source of truth for execution order.
  const rawOrder = typeof entry.order === 'number' ? entry.order : NaN;
  const order = Number.isInteger(rawOrder) && rawOrder > 0 ? rawOrder : index + 1;

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

  const blockedByResult = resolveBlockedBy(entry.blockedBy, index, placeholder, placeholderMap);
  if (!blockedByResult.ok) return Result.error(blockedByResult.error);

  let extraDimensions: readonly string[] | undefined;
  if (entry.extraDimensions !== undefined) {
    const r = coerceStringArray(entry.extraDimensions, `task[${String(index)}].extraDimensions`);
    if (!r.ok) return Result.error(r.error);
    extraDimensions = r.value;
  }

  const description = typeof entry.description === 'string' ? entry.description : undefined;

  return Task.create({
    id,
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

/**
 * Resolve every `blockedBy` placeholder string to a real {@link TaskId} via
 * `placeholderMap`. The strings are arbitrary labels — the AI may use
 * `"1"`, `"auth-setup"`, or even an 8-hex-by-coincidence value; we never
 * try to validate them as TaskIds.
 */
function resolveBlockedBy(
  raw: unknown,
  index: number,
  selfPlaceholder: string | null,
  placeholderMap: ReadonlyMap<string, TaskId>
): Result<readonly TaskId[] | undefined, ParseError> {
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
    if (typeof dep !== 'string' || dep.length === 0) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `task[${String(index)}].blockedBy contains a non-string entry`,
        })
      );
    }
    if (selfPlaceholder !== null && dep === selfPlaceholder) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `task[${String(index)}] references itself in blockedBy ('${dep}')`,
          hint: 'A task cannot depend on itself; remove the self-reference.',
        })
      );
    }
    const resolved = placeholderMap.get(dep);
    if (resolved === undefined) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `task[${String(index)}].blockedBy references unknown placeholder '${dep}'; declare it as another task's 'id' field`,
          hint: 'Every `blockedBy` entry must match the `id` of another task in this array.',
        })
      );
    }
    ids.push(resolved);
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
