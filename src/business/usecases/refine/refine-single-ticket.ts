/**
 * `RefineSingleTicketUseCase` — drives one HITL refinement pass for a
 * single ticket and returns the updated `Ticket` (`pending` → `approved`).
 *
 * Two modes, picked by the caller:
 *
 *  - **Headless** (`interactive: false`) — spawns Claude in `-p` mode,
 *    captures stdout, strips conversational preamble, treats the rest as
 *    the requirements body. Used in CI / non-TTY contexts where there's
 *    no human to chat with.
 *
 *  - **Interactive** (`interactive: true`) — hands the terminal over to
 *    Claude with `stdio: 'inherit'` so the user has the full Claude Code
 *    UI: ask-user-questions, planning, the works. Claude is told (via
 *    the prompt template's `Write to: {{OUTPUT_FILE}}` line) to write
 *    the final requirements JSON to a known file path. After Claude
 *    exits, the harness reads that file and pulls the requirements out.
 *    Restoring the alt-screen and clearing Ink during the session is
 *    handled by `runInteractive` upstream.
 *
 * Single-responsibility on purpose: looping over the sprint's pending
 * tickets, persistence, and per-ticket UI confirmation are chain-layer
 * concerns. This class only owns the AI round-trip + entity transition.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';

/** Inputs to {@link RefineSingleTicketUseCase}. */
export interface RefineSingleTicketInput {
  /** Loaded sprint — caller has already passed the draft / state guard. */
  readonly sprint: Sprint;
  /** Ticket to refine. Must be `requirementStatus === 'pending'`. */
  readonly ticket: Ticket;
  /** Working directory for the AI session. */
  readonly cwd: AbsolutePath;
  /**
   * When true, runs Claude with stdio: 'inherit' — the user has a live
   * conversation with Claude, and final requirements are read from
   * `outputFilePath` after exit. When false (default), spawns headless
   * and parses requirements from stdout.
   */
  readonly interactive?: boolean;
  /**
   * Required when `interactive` is true. Absolute path the AI is told
   * to write the refined requirements JSON to. The harness reads it
   * back after Claude exits.
   */
  readonly outputFilePath?: string;
  /**
   * Optional handover function used in interactive mode. The chain
   * layer wraps the `ai.spawnInteractive(...)` call in this so Ink can
   * pause its rendering while the child owns the terminal. Headless
   * mode does not need it.
   */
  readonly runInTerminal?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Optional pre-fetched issue context (ExternalPort.formatIssueContext
   * output). When provided, the prompt builder injects it instead of
   * the bare-link rendering — Claude sees the actual issue body +
   * comments, not just the URL.
   */
  readonly issueContext?: string;
  /**
   * Optional human-in-the-loop review hook. Called AFTER the AI session
   * finishes and the parsed requirements are extracted, BEFORE the
   * ticket transitions to `approved`. Return `true` to accept and
   * approve, `false` to skip — when skipped the use case returns the
   * input ticket unchanged with `accepted: false` so the chain can
   * move on without persisting. Headless / CI typically omit this.
   */
  readonly reviewBeforeApprove?: (proposedRequirements: string, ticket: Ticket) => Promise<boolean>;
  /** Optional cooperative cancellation. */
  readonly abortSignal?: AbortSignal;
}

/** Outputs from {@link RefineSingleTicketUseCase}. */
export interface RefineSingleTicketOutput {
  /**
   * Resulting ticket. When `accepted: true` this is the approved
   * ticket with its `requirements` body set. When `accepted: false`
   * the user reviewed the proposal and declined — this is the input
   * ticket unchanged.
   */
  readonly ticket: Ticket;
  /** Raw AI output — stdout in headless, file body in interactive. */
  readonly rawAiOutput: string;
  /**
   * `true` when the requirements were approved (either by `reviewBeforeApprove`
   * returning true, or by being absent — headless contexts have no reviewer
   * and treat the AI's output as accepted by default). `false` when the
   * reviewer rejected the proposal — chain layer should skip persistence
   * and move to the next ticket.
   */
  readonly accepted: boolean;
}

export class RefineSingleTicketUseCase {
  constructor(
    private readonly ai: AiSessionPort,
    private readonly prompts: PromptBuilderPort,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: RefineSingleTicketInput): Promise<Result<RefineSingleTicketOutput, DomainError>> {
    if (input.ticket.requirementStatus !== 'pending') {
      return Result.error(
        new InvalidStateError({
          entity: 'ticket',
          currentState: input.ticket.requirementStatus,
          attemptedAction: 'refine',
        })
      );
    }

    const log = this.logger.child({
      sprintId: input.sprint.id,
      ticketId: input.ticket.id,
    });

    const interactive = input.interactive === true;
    if (interactive && (input.outputFilePath === undefined || input.outputFilePath === '')) {
      return Result.error(
        new InvalidStateError({
          entity: 'ticket',
          currentState: 'missing-output-path',
          attemptedAction: 'refine',
          message: 'interactive refine requires an outputFilePath so the harness can read the AI output',
        })
      );
    }

    const promptResult = await this.prompts.buildRefinePrompt({
      ticket: input.ticket,
      ...(interactive && input.outputFilePath !== undefined ? { outputFilePath: input.outputFilePath } : {}),
      ...(input.issueContext !== undefined && input.issueContext.length > 0
        ? { issueContext: input.issueContext }
        : {}),
    });
    if (!promptResult.ok) return Result.error(promptResult.error);

    log.info(`refining ticket ${String(input.ticket.id)}${formatTitleSuffix(input.ticket.title)}`, {
      mode: interactive ? 'interactive' : 'headless',
    });

    if (interactive) {
      return this.runInteractive(input, promptResult.value, log);
    }
    return this.runHeadless(input, promptResult.value, log);
  }

  // ── headless (stdout-parsing path) ───────────────────────────────────

  private async runHeadless(
    input: RefineSingleTicketInput,
    prompt: string,
    log: ReturnType<LoggerPort['child']>
  ): Promise<Result<RefineSingleTicketOutput, DomainError>> {
    const sessionResult = await this.ai.spawnHeadless(prompt, {
      cwd: input.cwd,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });
    if (!sessionResult.ok) return Result.error(sessionResult.error);

    // Run the same JSON-tolerant parse as interactive mode — the prompt
    // template instructs Claude to emit the same array shape regardless of
    // mode, so the stored `requirements` is the parsed body, not raw JSON.
    const parsed = parseRequirementsJson(sessionResult.value.output, input.ticket);
    if (!parsed.ok) return Result.error(parsed.error);

    return this.finaliseProposal(input, parsed.value, sessionResult.value.output, log);
  }

  // ── interactive (Claude Code UI + read-back from file) ───────────────
  //
  // The full prompt is stashed in `refine-context.md` next to the output
  // file; Claude is bootstrapped with a one-liner pointing at it. The
  // chat history stays clean — Claude reads the context file as its
  // first action instead of having ~200 lines of spec scroll past
  // before it responds.

  private async runInteractive(
    input: RefineSingleTicketInput,
    prompt: string,
    log: ReturnType<LoggerPort['child']>
  ): Promise<Result<RefineSingleTicketOutput, DomainError>> {
    // The runInTerminal handover is required when Ink is mounted; in
    // non-Ink contexts (CLI, tests) callers can pass a passthrough.
    const handover = input.runInTerminal ?? (async <T>(fn: () => Promise<T>): Promise<T> => fn());

    // Write the full prompt to refine-context.md alongside the output
    // file. Claude's spawnInteractive bootstrap message tells it to
    // read this file. The directory was already pre-created by the
    // chain leaf; mkdir again here for safety in non-chain callers.
    const outputPath = input.outputFilePath ?? '';
    const contextDir = dirname(outputPath);
    const contextPath = `${contextDir}/refine-context.md`;
    try {
      await mkdir(contextDir, { recursive: true });
      await writeFile(contextPath, prompt, 'utf-8');
    } catch (err) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `interactive refine: failed to write context file at ${contextPath}: ${err instanceof Error ? err.message : String(err)}`,
          path: contextPath,
          cause: err,
        })
      );
    }

    // Short bootstrap: Claude's first turn reads the context file and
    // proceeds. Pass the context dir as `--add-dir` so Claude's
    // acceptEdits permission mode auto-allows reads/writes inside it
    // (no per-file prompt for the handoff and the output JSON). Bash /
    // WebFetch / etc still prompt — that's intentional, the user is at
    // the keyboard.
    const bootstrap = `I need help refining the requirements for "${input.ticket.title}". The full context is in \`${contextPath}\`. Please read that file now and follow the instructions to help refine the ticket requirements.`;

    const spawnResult = await handover(() =>
      this.ai.spawnInteractive(bootstrap, {
        cwd: input.cwd,
        args: ['--add-dir', contextDir],
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      })
    );
    if (!spawnResult.ok) return Result.error(spawnResult.error);

    // The AI was instructed (via the {{OUTPUT_FILE}} placeholder) to
    // write the refined requirements JSON to outputFilePath. Read it.
    // (`interactive: true` is gated above to require outputFilePath, so
    // this is non-empty by construction — narrow with a runtime check.)
    const path = input.outputFilePath ?? '';
    if (path === '') {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: 'interactive refine: outputFilePath required (validated above; should not reach this branch)',
        })
      );
    }
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (err) {
      log.warn(`refine output file missing for ticket ${String(input.ticket.id)}`, {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `interactive refine: AI did not write requirements to ${path}. Re-run and ensure Claude reaches the "Write to file" step before exiting.`,
          path,
          cause: err,
        })
      );
    }

    const parsed = parseRequirementsJson(raw, input.ticket);
    if (!parsed.ok) return Result.error(parsed.error);

    return this.finaliseProposal(input, parsed.value, raw, log);
  }

  /**
   * Final stage shared by both modes: optionally let a reviewer veto
   * (`reviewBeforeApprove`), then either approve the ticket or return
   * it unchanged with `accepted: false`. Emits a success-level milestone
   * log on approval so the live execute view's "Recent events" panel
   * surfaces the transition distinctly.
   */
  private async finaliseProposal(
    input: RefineSingleTicketInput,
    proposed: string,
    rawAiOutput: string,
    log: ReturnType<LoggerPort['child']>
  ): Promise<Result<RefineSingleTicketOutput, DomainError>> {
    if (input.reviewBeforeApprove !== undefined) {
      const accept = await input.reviewBeforeApprove(proposed, input.ticket);
      if (!accept) {
        return Result.ok({
          ticket: input.ticket,
          rawAiOutput,
          accepted: false,
        });
      }
    }
    const approved = input.ticket.approveRequirements(proposed);
    if (!approved.ok) return Result.error(approved.error);
    log.success(`refined ticket ${String(approved.value.id)}${formatTitleSuffix(approved.value.title)}`);
    return Result.ok({
      ticket: approved.value,
      rawAiOutput,
      accepted: true,
    });
  }
}

// ── output parsing (shared between headless + interactive) ─────────────
// The interactive prompt instructs Claude to write a JSON array with
// objects like `{ ref, requirements }`. Pull the requirements field for
// the ticket we asked about. Tolerant: if the AI wrote a single object
// instead of an array, accept that too. If parsing fails altogether,
// fall back to treating the raw text as the requirements body so a user
// who closed Claude after writing markdown rather than JSON isn't
// stranded — the harness still captures something useful.

interface RefinementJsonObject {
  readonly ref?: string;
  readonly requirements?: string;
}

function parseRequirementsJson(raw: string, ticket: Ticket): Result<string, StorageError> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: 'interactive refine: AI wrote an empty file. Re-run and have Claude finish the Write step.',
      })
    );
  }
  // Try JSON first.
  try {
    const value: unknown = JSON.parse(stripCodeFence(trimmed));
    const requirements = pickRequirements(value, ticket);
    if (requirements !== null) return Result.ok(requirements);
  } catch {
    // Fall through to the non-JSON fallback.
  }
  // Fallback: treat the whole file as the requirements body. The user
  // gets a working ticket; the warning above covers the soft failure.
  return Result.ok(trimmed);
}

function stripCodeFence(s: string): string {
  // Some Claude responses wrap JSON in ```json … ``` fences.
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
  const m = fence.exec(s.trim());
  return m?.[1] ?? s;
}

function pickRequirements(value: unknown, ticket: Ticket): string | null {
  const candidates: RefinementJsonObject[] = [];
  if (Array.isArray(value)) {
    for (const v of value) if (isRefinementObj(v)) candidates.push(v);
  } else if (isRefinementObj(value)) {
    candidates.push(value);
  }
  if (candidates.length === 0) return null;
  // Prefer a ref match (id or title); else fall back to the first.
  const idStr = String(ticket.id);
  const titleStr = ticket.title;
  const matched = candidates.find((c) => c.ref === idStr || c.ref === titleStr);
  const chosen = matched ?? candidates[0];
  if (chosen?.requirements && chosen.requirements.trim().length > 0) {
    return chosen.requirements;
  }
  return null;
}

function isRefinementObj(v: unknown): v is RefinementJsonObject {
  return typeof v === 'object' && v !== null;
}

/**
 * Render a ticket title slice for log messages. Empty / whitespace-only
 * titles return an empty string so the caller can concatenate without
 * leaving a dangling ` — ""`. Long titles are clipped to 50 chars with
 * a single-character ellipsis so the log tail stays readable.
 */
function formatTitleSuffix(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return '';
  const max = 50;
  const slice = trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  return ` — "${slice}"`;
}
