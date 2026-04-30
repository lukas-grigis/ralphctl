/**
 * Pure formatter for domain errors.
 *
 * Renders a {@link DomainError} to a multi-line string suitable for stderr:
 *   - Line 1: red `error` tag, dim `[code]`, then the message.
 *   - Line 2 (optional): dim `↳ hint: <hint>` when the error carries a hint.
 *
 * Pure function — no side effects, no IO. Callers (e.g. `printError` in the
 * command runner) are responsible for writing it to a stream.
 */
import * as c from 'colorette';

import type { DomainError } from '../../../domain/errors/domain-error.ts';

/**
 * Narrow shape used to read the optional `hint` field. Keeps the type-only
 * dependency narrow — every `DomainError` member declares the field, but the
 * union type doesn't structurally surface it without this widening.
 */
interface WithHint {
  readonly hint?: unknown;
}

/** Render a single domain error to a multi-line string. */
export function formatError(error: DomainError): string {
  const tag = c.red(c.bold('error'));
  const code = c.dim(`[${error.code}]`);
  const lines: string[] = [`${tag} ${code} ${error.message}`];

  const hint = (error as WithHint).hint;
  if (typeof hint === 'string' && hint.length > 0) {
    lines.push(`  ${c.dim('↳ hint:')} ${hint}`);
  }

  return lines.join('\n');
}
