import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AiSignal } from '@src/domain/signal.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';
import { renderSidecars } from '@src/integration/ai/contract/_engine/render-sidecars.ts';
import { validateSignalsFileWithCorrectiveRetry } from '@src/integration/ai/contract/_engine/corrective-retry.ts';
import type { PublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import { capProgressBody, progressCapBudgetForModel } from '@src/application/flows/_shared/progress/cap-progress.ts';
import { composeProjectTooling } from '@src/application/flows/implement/leaves/_shared/compose-project-tooling.ts';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import {
  readRoundSessionId,
  roundBodyPath,
  roundCorrectiveBodyPath,
  roundSignalsPath,
  writeRoundPrompt,
} from '@src/application/flows/implement/leaves/round-artifacts.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Everything one gen-eval role turn does that is identical for the generator and the evaluator.
 *
 * The two roles differ only in WHAT they ask for — the prompt, the output contract, the grounding
 * a cold corrective spawn needs, what they do with the parsed signals — and WHICH model / effort
 * the spawn runs at. The rest is one pipeline: read the ctx preconditions, resolve the round's
 * on-disk paths, read the capped journal excerpt, name the installed tooling, persist the prompt,
 * spawn, validate `signals.json` with bounded corrective nudges on the resumed thread, hand the
 * validated signals back, render the harness-owned sidecars. That pipeline lives here so the two
 * roles cannot drift apart.
 *
 * Nothing here touches ctx or mutates caller state: the corrective-nudge tally comes back in the
 * return value, and the only caller-supplied side effect is {@link RoleTurnArgs.onSignals}.
 */
export interface RoleTurnDeps {
  readonly provider: HeadlessAiProvider;
  /** Output port for harness-rendered sidecars — the AI only ever writes `signals.json` itself. */
  readonly writeFile: WriteFile;
  /** The AI session's working directory (the user's repo). */
  readonly cwd: AbsolutePath;
  /** Sprint directory — mounted as a second `--add-dir` so the AI can read `progress.md`. */
  readonly sprintDir: AbsolutePath;
  readonly logger: Logger;
  /** Bounded corrective in-round nudges before a contract failure self-blocks (1–5). */
  readonly correctiveRetries: number;
}

/**
 * Deps every gen-eval role leaf takes, on top of the turn pipeline's own {@link RoleTurnDeps}.
 * The generator and evaluator leaves each extend this with the handful of ports only they need
 * (the generator's round-boundary event bus + verify-log reader, the evaluator's git runner).
 */
export interface RoleLeafDeps extends RoleTurnDeps {
  readonly templateLoader: TemplateLoader;
  /**
   * Fan-out seam for every validated signal this turn — the ONE harness-signal channel
   * (see `publish-signal.ts`). Pre-bound with this leaf's `source` (and, on the implement
   * parallel path, the owning branch's `taskId`) by the caller.
   */
  readonly publishSignal: PublishSignal;
  /**
   * Absolute path to `<sprintDir>/progress.md` — the sprint-wide journal. Both roles inline a
   * capped excerpt of it into their prompt (see {@link readCappedProgress}) and name the file so
   * the AI can read the rest through the `sprintDir` mount.
   */
  readonly progressFile: AbsolutePath;
  /** Configured model for this role. A per-task escalation may override it at spawn time. */
  readonly model: string;
  /** Optional reasoning / effort level forwarded into every `implementSession` AiSession. */
  readonly effort?: string;
  /**
   * Pre-composed bound-agent-definition prompt body (raw content — `renderAgentDefinitionSection`
   * wraps it under the "## Agent Definition" heading at render time) — see
   * `GenEvalLoopRoleConfig.agentDefinitionSection`. Rides the FULL prompt only (round 1 of a
   * session thread); a resumed continuation already carries it in-conversation.
   */
  readonly agentDefinition?: string;
  /**
   * This role's bound agent-definition NAME (the portable-agents feature's bare identifier, not
   * the rendered {@link agentDefinition} section) — threaded separately so the FULL prompt's
   * `{{PROJECT_TOOLING}}` catalog can name the same binding `{{AGENT_DEFINITION_SECTION}}`
   * already announces, without re-parsing the rendered prose. Absent when the role has no
   * binding. See `compose-project-tooling.ts`.
   */
  readonly agentDefinitionName?: string;
  /**
   * Per-flow skill catalog port — the same source `installSkillsLeaf` reads to install this
   * task's skills into the session sandbox. Read again here (best-effort) to name each installed
   * skill in the FULL prompt's `{{PROJECT_TOOLING}}` catalog (round 1 of a session thread only).
   * Absent → the catalog simply omits the skills lines.
   */
  readonly skillSource?: SkillSource;
  readonly verifyScript?: string;
  /** From `settings.harness.plateauThreshold` (2–5). */
  readonly plateauThreshold: number;
  readonly clock: () => IsoTimestamp;
}

/**
 * Ctx preconditions every role turn needs. Read once through {@link requireRoleTurnCtx} so both
 * leaves fail the same way, with the same message, when an upstream leaf did not run.
 */
export interface RoleTurnCtx {
  readonly task: InProgressTask;
  readonly workspaceRoot: AbsolutePath;
  readonly roundNum: number;
}

/**
 * Validate the ctx preconditions for one role turn and project them into {@link RoleTurnCtx}.
 *
 * Throws {@link InvalidStateError} — a ctx-shape violation inside a leaf projection is a
 * programmer error (the surrounding chain ran the leaves out of order), not a domain outcome, so
 * it is one of the few places the codebase throws rather than returning a `Result`.
 */
export const requireRoleTurnCtx = (ctx: ImplementCtx, role: 'generator' | 'evaluator', taskId: TaskId): RoleTurnCtx => {
  const action = `${role}-${String(taskId)}`;
  const stage = `pre-${role}`;
  const err = (entity: 'chain' | 'task', currentState: string, detail: string): InvalidStateError =>
    new InvalidStateError({ entity, currentState, attemptedAction: action, message: `${action}: ${detail}` });
  if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId)
    throw err('chain', stage, 'ctx.currentTask missing or mismatched');
  if (ctx.currentTask.status !== 'in_progress') throw err('task', ctx.currentTask.status, 'expected in_progress task');
  if (ctx.taskWorkspaceRoot === undefined)
    throw err('chain', stage, 'ctx.taskWorkspaceRoot missing — build-task-workspace must run first');
  if (ctx.currentRoundNum === undefined)
    throw err('chain', stage, 'ctx.currentRoundNum missing — resolve-round-num must run first');
  return { task: ctx.currentTask, workspaceRoot: ctx.taskWorkspaceRoot, roundNum: ctx.currentRoundNum };
};

/** The round's `signals.json` and the per-round directory that holds it plus its sidecars. */
export interface RoundPaths {
  readonly signalsFile: AbsolutePath;
  readonly outputDir: AbsolutePath;
}

/**
 * Resolve `rounds/<N>/<role>/signals.json` and the directory containing it. Derived from ONE path
 * so the spawn's `signalsFile`, the validator's `outputDir`, and the sidecar target stay
 * structurally coupled and cannot disagree.
 */
export const resolveRoundPaths = (
  workspaceRoot: AbsolutePath,
  roundNum: number,
  role: 'generator' | 'evaluator'
): Result<RoundPaths, DomainError> => {
  const signalsFile = AbsolutePath.parse(roundSignalsPath(workspaceRoot, roundNum, role));
  if (!signalsFile.ok) return Result.error(signalsFile.error);
  const outputDir = AbsolutePath.parse(dirname(String(signalsFile.value)));
  if (!outputDir.ok) return Result.error(outputDir.error);
  return Result.ok({ signalsFile: signalsFile.value, outputDir: outputDir.value });
};

/**
 * Read the current `progress.md` body to inline into a role's prompt, CAPPED to the sprint
 * header, ALL of the current task's own attempt sections, and the last N other-task sections (see
 * {@link capProgressBody}). `progress.md` is sprint-wide and append-only, so a late-sprint journal
 * is dozens of sections long; inlining the whole body into every turn grew token cost
 * superlinearly. The cap bounds breadth across siblings — the current task's own history rides in
 * full because its earlier warnings / escalations / remedies are the depth the next turn must
 * honour — while the FULL file stays on disk, reachable to the AI via the `sprintDir` `--add-dir`
 * mount named in the prompt, with every elision marked in place. Applied to both the full prompt
 * (round 1 / fresh session) and the continuation prompt, for both roles.
 *
 * Best-effort: a missing / unreadable file returns the empty string so the template's surrounding
 * prose handles the empty case without a per-flow special branch. The current task's own history
 * is matched on its STABLE id (not its name); the sibling breadth bound scales to the configured
 * model's context window.
 */
export const readCappedProgress = async (path: string, currentTaskId: string, model: string): Promise<string> => {
  try {
    return capProgressBody(await fs.readFile(path, 'utf8'), {
      currentTaskId,
      recentBudgetTokens: progressCapBudgetForModel(model),
    });
  } catch {
    return '';
  }
};

/**
 * Resolve the FULL prompt's `{{PROJECT_TOOLING}}` carry (round 1 of a session thread only — the
 * continuation prompts do not declare the placeholder, mirroring `agentDefinition`'s
 * full-prompt-only rule). The skill catalog is flow-wide, shared by both roles. Returns the
 * ready-to-spread `{ projectTooling }` fragment (or `{}` when there is nothing to name) so the
 * caller stays a flat, branch-free spread. Best-effort: a skill-source read failure degrades to
 * naming only the bound agent definition (or to nothing at all) rather than failing the turn —
 * tooling-catalog enrichment must never block a round.
 */
export const resolveProjectToolingCarry = async (
  deps: Pick<RoleLeafDeps, 'agentDefinitionName' | 'skillSource'>
): Promise<{ readonly projectTooling?: string }> => {
  const skills = deps.skillSource !== undefined ? await deps.skillSource.getForFlow('implement') : undefined;
  const projectTooling = composeProjectTooling({
    ...(deps.agentDefinitionName !== undefined ? { agentDefinitionName: deps.agentDefinitionName } : {}),
    ...(skills?.ok === true ? { skills: skills.value } : {}),
  });
  return projectTooling.length > 0 ? { projectTooling } : {};
};

/**
 * Grounding appended to every corrective nudge body. Load-bearing when the corrective spawn comes
 * up COLD (no resumable id / codex stale-resume fallback): without it a context-free retry's whole
 * prompt is the error text, and the model would emit signals — for the evaluator, a whole verdict
 * — from that message alone instead of re-reading the work. `extraLines` carries the role's own
 * grounding (the evaluator's "the diff is your primary input" instruction); the task spec and the
 * per-round output contract ride for both roles.
 */
export const selfContainedGrounding = (
  workspaceRoot: AbsolutePath,
  outputContractSection: string,
  extraLines: readonly string[] = []
): string =>
  [
    `Task spec (read it): \`${join(String(workspaceRoot), 'contract.md')}\``,
    ...extraLines,
    '',
    outputContractSection,
  ].join('\n');

export interface RoleTurnArgs<TSig extends AiSignal> {
  readonly role: 'generator' | 'evaluator';
  readonly workspaceRoot: AbsolutePath;
  readonly roundNum: number;
  readonly signalsFile: AbsolutePath;
  /** Per-round output directory (`rounds/<N>/<role>/`) — the parent of {@link signalsFile}. */
  readonly outputDir: AbsolutePath;
  /**
   * Model this turn's spawn runs on. Resolved by the caller so each role keeps its own rule
   * explicit — the generator honours a per-task `escalatedToModel`, the evaluator never does.
   */
  readonly model: string;
  /** Reasoning / effort level for this turn's spawn — the corrective respawn matches it. */
  readonly effort: string | undefined;
  /**
   * Captured session id from the PRIOR round's turn of this role. Threaded into the initial spawn
   * as `--resume`, and used as the corrective respawn's fallback target when this spawn never
   * reported an id of its own.
   */
  readonly priorSessionId: SessionId | undefined;
  readonly signal: AbortSignal | undefined;
  readonly contract: AiOutputContract<TSig>;
  /**
   * Build this turn's prompt. A builder (not a ready `Prompt`) so the caller's prompt composition
   * — which may read the journal, the workspace, or the skill catalog — stays lazy and inside the
   * role that owns it.
   */
  readonly buildPrompt: () => Promise<Result<Prompt, DomainError>>;
  /** Role grounding appended to every corrective body — see {@link selfContainedGrounding}. */
  readonly selfContainedContext: string;
  /**
   * Fan-out for the validated signals, invoked once before the sidecars render. The generator
   * publishes + accumulates per-kind texts; the evaluator only publishes.
   */
  readonly onSignals: (signals: readonly TSig[]) => void;
}

export interface RoleTurnOutcome<TSig extends AiSignal> {
  readonly signals: readonly TSig[];
  /**
   * Corrective `signals.json` nudges this turn consumed (`0` on a clean first parse). Pure
   * cost-visibility instrumentation — the caller accumulates it onto ctx for the progress journal.
   */
  readonly nudgeCount: number;
}

/** One spawn of this role's session, with a per-spawn resume target + forensic body mirror. */
const spawnRole = async <TSig extends AiSignal>(
  deps: RoleTurnDeps,
  args: RoleTurnArgs<TSig>,
  prompt: Prompt,
  resume: SessionId | undefined,
  bodyPath: string
): ReturnType<HeadlessAiProvider['generate']> => {
  // Best-effort parse — a bad path just omits the forensic mirror, never fails the spawn.
  const bodyFile = AbsolutePath.parse(bodyPath);
  return deps.provider.generate(
    implementSession(
      args.workspaceRoot,
      deps.cwd,
      deps.sprintDir,
      prompt,
      args.model,
      args.signalsFile,
      args.role,
      resume,
      args.effort,
      args.signal,
      bodyFile.ok ? bodyFile.value : undefined
    )
  );
};

/**
 * Build this turn's corrective-retry `reinvoke` callback — resumes the just-spawned thread
 * (falling back to the prior round's session id when this spawn never reported one to disk) so
 * the corrective message lands as a follow-up turn on the SAME conversation the AI just wrote
 * invalid/missing signals from. Each nudge gets its own body mirror so a 2nd/3rd nudge never
 * clobbers an earlier capture.
 */
const makeReinvoke =
  <TSig extends AiSignal>(
    deps: RoleTurnDeps,
    args: RoleTurnArgs<TSig>
  ): ((corrective: Prompt, attempt: number) => Promise<Result<void, DomainError>>) =>
  async (corrective, attempt) => {
    const resume = (await readRoundSessionId(args.workspaceRoot, args.roundNum, args.role)) ?? args.priorSessionId;
    const respawn = await spawnRole(
      deps,
      args,
      corrective,
      resume,
      roundCorrectiveBodyPath(args.workspaceRoot, args.roundNum, args.role, attempt)
    );
    return respawn.ok ? Result.ok(undefined) : Result.error(respawn.error);
  };

/**
 * Run one role's AI turn end to end. See the module docstring for the split of responsibilities
 * between this pipeline and its caller.
 *
 * The rendered prompt is persisted under `rounds/<N>/<role>/prompt.md` BEFORE the spawn so a
 * crash mid-call still leaves the prompt that triggered it on disk for post-hoc replay
 * (best-effort — the writer logs and swallows on failure).
 *
 * A still-failing contract validation comes back as `Result.error`; the role's use case converts
 * that into a `self-blocked` exit (task settles as blocked, run continues). Only a fatal
 * `Aborted` / `RateLimit` propagates and aborts the run.
 */
export const runRoleTurn = async <TSig extends AiSignal>(
  deps: RoleTurnDeps,
  args: RoleTurnArgs<TSig>
): Promise<Result<RoleTurnOutcome<TSig>, DomainError>> => {
  const prompt = await args.buildPrompt();
  if (!prompt.ok) return Result.error(prompt.error);
  await writeRoundPrompt(args.workspaceRoot, args.roundNum, args.role, String(prompt.value), deps.logger);

  const spawn = await spawnRole(
    deps,
    args,
    prompt.value,
    args.priorSessionId,
    roundBodyPath(args.workspaceRoot, args.roundNum, args.role)
  );
  if (!spawn.ok) return Result.error(spawn.error);

  // Validate `signals.json` against this role's contract. On a RECOVERABLE failure
  // (signals-missing / invalid-json / schema-mismatch) re-prompt on the resumed session with a
  // corrective message + the Zod issue list, then re-validate.
  const validated = await validateSignalsFileWithCorrectiveRetry(
    {
      outputDir: args.outputDir,
      logger: deps.logger,
      correctiveRetries: deps.correctiveRetries,
      selfContainedContext: args.selfContainedContext,
      reinvoke: makeReinvoke(deps, args),
    },
    args.contract
  );
  if (!validated.ok) return Result.error(validated.error);

  args.onSignals(validated.value.signals);

  // Harness-owned sidecars (the generator's `commit-message.txt`, the evaluator's
  // `evaluation.md`). Write failures log warn inside `renderSidecars`; the helper always returns
  // `Result.ok` — sidecars are operator UX only, downstream leaves read the in-memory signals.
  await renderSidecars(deps.writeFile, args.outputDir, validated.value.signals, args.contract.sidecars, deps.logger);

  return Result.ok({ signals: validated.value.signals, nudgeCount: validated.value.nudgeCount });
};
