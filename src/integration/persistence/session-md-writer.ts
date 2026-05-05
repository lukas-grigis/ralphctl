/**
 * `session-md-writer` — write per-AI-session markdown files with a YAML
 * frontmatter header and a `## Prompt` body.
 *
 * Each AI session under a per-unit folder gets a `session.md` (refine /
 * plan / ideate stamp a single one at the unit root; the per-task chain
 * routes each spawn into `rounds/<N>/{generator,evaluator}/session.md`)
 * so the user can audit exactly what the harness handed the model and
 * how the spawn settled. Two write phases:
 *
 *  - {@link writeSessionStart} — called immediately before the spawn.
 *    Writes provider / model / cwd / flags / sessionId / started + the
 *    full prompt body. Finished and exitCode are absent in the
 *    frontmatter at this point.
 *  - {@link writeSessionFinish} — called immediately after the spawn
 *    settles. Re-reads the file, preserves the prompt body, replaces
 *    the frontmatter with finished-state values (finished, exitCode,
 *    sessionId if newly assigned).
 *
 * The frontmatter format is intentionally tiny — flat string / number
 * values plus a single string array (`flags: [a, b, c]`). A custom
 * line-based parser handles it; pulling in a full YAML library would
 * be overkill for these few keys.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';

export interface SessionStartArgs {
  /** Absolute target file path (e.g. `<unitDir>/session.md` or `session-1.md`). */
  readonly path: string;
  readonly provider: string;
  readonly model?: string;
  readonly cwd: string;
  readonly flags: readonly string[];
  readonly sessionId?: string;
  /** ISO-8601 timestamp string. */
  readonly started: string;
  /** The fully-rendered prompt the AI was handed. */
  readonly promptBody: string;
}

export interface SessionFinishArgs {
  readonly path: string;
  /** ISO-8601 timestamp string. */
  readonly finished: string;
  /** 0 on clean exit; non-zero / null on failure or unknown. */
  readonly exitCode: number | null;
  /** New session id assigned by the provider, when surfaced. */
  readonly sessionId?: string;
}

const FRONTMATTER_DELIM = '---';

function renderFrontmatter(fields: Record<string, string | number | null | readonly string[] | undefined>): string {
  const lines: string[] = [FRONTMATTER_DELIM];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const arr = value as readonly string[];
      lines.push(`${key}: [${arr.map((s) => quoteIfNeeded(s)).join(', ')}]`);
      continue;
    }
    if (value === null) {
      lines.push(`${key}: null`);
      continue;
    }
    if (typeof value === 'number') {
      lines.push(`${key}: ${String(value)}`);
      continue;
    }
    // Narrowed by elimination: value is string here.
    lines.push(`${key}: ${quoteIfNeeded(value as string)}`);
  }
  lines.push(FRONTMATTER_DELIM);
  return lines.join('\n');
}

function quoteIfNeeded(s: string): string {
  // Quote anything that would confuse the line-based parser. ISO
  // timestamps contain `:` but a bare `2026-05-04T10:00:00Z` parses
  // unambiguously — only quote when the colon is followed by a space,
  // which is what the parser treats as a key/value boundary.
  if (/:\s/.test(s) || /[#\n"]/.test(s) || s.trimStart() !== s) {
    const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return s;
}

function renderBody(promptBody: string): string {
  const trimmed = promptBody.endsWith('\n') ? promptBody : `${promptBody}\n`;
  return `## Prompt\n\n${trimmed}`;
}

async function writeFileSafe(path: string, content: string): Promise<Result<void, StorageError>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content.endsWith('\n') ? content : `${content}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return Result.ok();
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`,
        path,
        cause: err,
      })
    );
  }
}

/**
 * Write the start-of-session frontmatter + prompt body.
 *
 * Overwrites any prior file at the path (a re-run of the same session is
 * the natural overwrite case — the prompt may have changed).
 */
export async function writeSessionStart(args: SessionStartArgs): Promise<Result<void, StorageError>> {
  const fm = renderFrontmatter({
    provider: args.provider,
    model: args.model,
    cwd: args.cwd,
    flags: args.flags,
    sessionId: args.sessionId,
    started: args.started,
  });
  const content = `${fm}\n\n${renderBody(args.promptBody)}`;
  return writeFileSafe(args.path, content);
}

/**
 * Update the frontmatter on an existing session file with finish-state
 * values. Preserves the prompt body verbatim. If the file is missing
 * (writeStart was never called) we still write a finish-only stub so
 * the audit trail is complete.
 */
export async function writeSessionFinish(args: SessionFinishArgs): Promise<Result<void, StorageError>> {
  let existing: string;
  try {
    existing = await readFile(args.path, 'utf-8');
  } catch {
    // No prior start file — write a finish-only frontmatter stub so the
    // session is still recorded somewhere.
    const fm = renderFrontmatter({
      finished: args.finished,
      exitCode: args.exitCode,
      sessionId: args.sessionId,
    });
    return writeFileSafe(args.path, `${fm}\n\n## Prompt\n\n_(no prompt recorded — session finish without start)_\n`);
  }

  const { fields, body } = parseSessionFile(existing);
  const merged: Record<string, string | number | readonly string[] | null | undefined> = { ...fields };
  merged['finished'] = args.finished;
  merged['exitCode'] = args.exitCode;
  if (args.sessionId !== undefined) merged['sessionId'] = args.sessionId;

  const fm = renderFrontmatter(merged);
  const content = `${fm}\n\n${body}`;
  return writeFileSafe(args.path, content);
}

interface ParsedSession {
  readonly fields: Record<string, string | number | readonly string[] | null>;
  /** Everything after the second `---` delimiter, verbatim. */
  readonly body: string;
}

function parseSessionFile(content: string): ParsedSession {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    // No frontmatter — treat the whole file as the body.
    return { fields: {}, body: content };
  }
  const fields: Record<string, string | number | readonly string[] | null> = {};
  let i = 1;
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === FRONTMATTER_DELIM) {
      i += 1;
      break;
    }
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? '';
    const raw = (m[2] ?? '').trim();
    if (key.length === 0) continue;
    fields[key] = parseValue(raw);
  }
  // Skip a single blank line right after the closing delimiter.
  if (lines[i]?.trim() === '') i += 1;
  const body = lines.slice(i).join('\n');
  return { fields, body };
}

function parseValue(raw: string): string | number | readonly string[] | null {
  if (raw === 'null') return null;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner.length === 0) return [];
    // Split on commas not inside quotes — flags are simple strings; no
    // nested arrays.
    return inner.split(',').map((part) => unquote(part.trim()));
  }
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return unquote(raw);
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}
