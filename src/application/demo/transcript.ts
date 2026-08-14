/**
 * Canned generator → evaluator transcript replayed by `ralphctl demo --script`.
 *
 * The story is deliberately the smallest one that shows what the harness actually does:
 *
 *   round 1 — the generator edits `hello.py` and claims the task is done; the evaluator runs the
 *             task's acceptance criterion, FAILS `correctness` and cites the exact mismatch.
 *   round 2 — the generator applies the critique; the evaluator re-runs the criterion and PASSES.
 *
 * Exactly two rounds, by design: the plateau / best-of-N escalation rungs need three consecutive
 * failing turns before they fire, so a two-round script can never wander into an escalation path
 * the recording is not meant to show (see `harness.plateauThreshold`).
 *
 * Every signal array is typed as the matching leaf contract's `exampleSignals` type, so a change
 * to the generator / evaluator signal sub-union breaks THIS file at typecheck rather than at
 * demo time. The payloads are not fabricated evidence in the misleading sense — the generator
 * beats really do write the files they claim to write (see `scripted-spawn.ts`), so the diff the
 * commit leaf records, the file the verify gate reads, and the prose below all agree.
 *
 * Nothing here spawns anything: this module is pure data.
 */

import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AiSignal } from '@src/domain/signal.ts';
import { evaluatorOutputContract } from '@src/application/flows/implement/leaves/evaluator.contract.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';

/** Role segment of a `rounds/<N>/<role>/signals.json` path — the transcript's dispatch key. */
export type DemoRole = 'generator' | 'evaluator';

/** The one source file the demo task touches, relative to the spawn's `cwd`. */
export const DEMO_TARGET_FILE = 'hello.py';

/**
 * Acceptance-criterion command for the seeded demo task, and the command the canned evaluator
 * evidence quotes. Node rather than python so the demo runs on any machine that can run
 * ralphctl at all — `scripted-run.ts` rewrites the seeded criterion to this exact string so the
 * task contract, the transcript's evidence, and reality all say the same thing.
 *
 * @public
 */
export const DEMO_CRITERION_COMMAND =
  "node -e \"const s=require('node:fs').readFileSync('hello.py','utf8'); if (!s.includes('Hello, world!')) process.exit(1)\"";

/**
 * Repository verify script for the demo sandbox. Deliberately green BOTH before and after the
 * task: a red pre-task-verify baseline opens the operator gate ("proceed on a broken tree?"),
 * which is not what a first-run recording should be showing. The acceptance criterion above is
 * where the red → green transition lives.
 *
 * @public
 */
export const DEMO_VERIFY_SCRIPT =
  "node -e \"const s=require('node:fs').readFileSync('hello.py','utf8'); if (!s.includes('print(')) process.exit(1)\"";

const ROUND_1_SOURCE = ['# Greeting for the ralphctl demo sprint.', 'print("Hello world")', ''].join('\n');

const ROUND_2_SOURCE = ['# Greeting for the ralphctl demo sprint.', 'print("Hello, world!")', ''].join('\n');

/** A file the scripted session writes into the spawn's `cwd` before it reports its signals. */
export interface DemoWorkspaceFile {
  /** Path relative to the spawn's `cwd`. Always posix-style; the writer joins it against `cwd`. */
  readonly path: string;
  readonly content: string;
}

/** One scripted spawn — everything the fake session does and says for a single round + role. */
export interface DemoBeat {
  readonly role: DemoRole;
  readonly round: number;
  /** Written (in order) before `signals.json`, mirroring an AI's Write-then-report ordering. */
  readonly files: readonly DemoWorkspaceFile[];
  /** `schemaVersion` of the wrapper the beat's contract expects. */
  readonly schemaVersion: number;
  readonly signals: readonly AiSignal[];
  /** Assistant prose mirrored on the stream-json `result` line — what the TUI shows live. */
  readonly body: string;
}

export interface DemoTranscript {
  readonly beats: readonly DemoBeat[];
}

const generatorSignals = (
  signals: typeof generatorOutputContract.exampleSignals
): typeof generatorOutputContract.exampleSignals => signals;

const evaluatorSignals = (
  signals: typeof evaluatorOutputContract.exampleSignals
): typeof evaluatorOutputContract.exampleSignals => signals;

/** Round 1 — the generator edits the file and reports the task complete. It is wrong. */
const generatorRoundOne = (at: IsoTimestamp): DemoBeat => ({
  role: 'generator',
  round: 1,
  files: [{ path: DEMO_TARGET_FILE, content: ROUND_1_SOURCE }],
  schemaVersion: generatorOutputContract.schemaVersion,
  signals: generatorSignals([
    { type: 'change', text: `rewrote the greeting in ${DEMO_TARGET_FILE}`, timestamp: at },
    {
      type: 'decision',
      text: 'Kept the single print statement rather than introducing a helper — the task asks for one literal line of output.',
      timestamp: at,
    },
    {
      type: 'task-verified',
      output: `$ ${DEMO_CRITERION_COMMAND}\nHello world`,
      timestamp: at,
    },
    {
      type: 'commit-message',
      subject: 'feat(demo): print a greeting from hello.py',
      body: 'Why: the placeholder greeting predates the demo task and says nothing about the sprint.',
      timestamp: at,
    },
    { type: 'task-complete', timestamp: at },
  ]),
  body: `Updated ${DEMO_TARGET_FILE} to print a greeting and ran the acceptance command.`,
});

/** Round 1 — the evaluator runs the acceptance criterion, FAILS correctness, and cites the mismatch. */
const evaluatorRoundOne = (at: IsoTimestamp): DemoBeat => ({
  role: 'evaluator',
  round: 1,
  files: [],
  schemaVersion: evaluatorOutputContract.schemaVersion,
  signals: evaluatorSignals([
    {
      type: 'evaluation',
      status: 'failed',
      dimensions: [
        {
          dimension: 'correctness',
          passed: false,
          finding: `${DEMO_TARGET_FILE}:2 prints "Hello world" — the criterion requires the exact string "Hello, world!" (comma + exclamation mark).`,
          executionEvidence: `$ ${DEMO_CRITERION_COMMAND}\nexit 1`,
        },
        { dimension: 'completeness', passed: true, finding: 'the only file the task names was edited' },
        { dimension: 'safety', passed: true, finding: 'no shell, network, or dependency changes' },
        {
          dimension: 'consistency',
          passed: true,
          finding: `the comment above the statement still describes ${DEMO_TARGET_FILE} accurately`,
        },
        {
          dimension: 'robustness',
          passed: true,
          applicable: false,
          finding: 'a single literal print statement has no error path to harden',
        },
      ],
      criteria: [
        {
          id: 'C1',
          passed: false,
          evidence: `the acceptance command exited 1 — "Hello, world!" is absent from ${DEMO_TARGET_FILE}`,
        },
      ],
      critique: `Correctness: ${DEMO_TARGET_FILE}:2 must print exactly "Hello, world!" — add the comma and the exclamation mark, then re-run the acceptance command.`,
      timestamp: at,
    },
    {
      type: 'note',
      text: 'The generator reported the command output but not its exit status — the string mismatch is only visible in the exit code.',
      timestamp: at,
    },
  ]),
  body: 'FAILED — correctness: the printed string does not match the acceptance criterion.',
});

/** Round 2 — the generator applies the critique verbatim. */
const generatorRoundTwo = (at: IsoTimestamp): DemoBeat => ({
  role: 'generator',
  round: 2,
  files: [{ path: DEMO_TARGET_FILE, content: ROUND_2_SOURCE }],
  schemaVersion: generatorOutputContract.schemaVersion,
  signals: generatorSignals([
    {
      type: 'change',
      text: `${DEMO_TARGET_FILE}:2 now prints the exact string "Hello, world!"`,
      timestamp: at,
    },
    {
      type: 'learning',
      text: 'Quote the acceptance string verbatim from the criterion instead of retyping it — punctuation is part of the contract.',
      context: 'the first round dropped the comma and the exclamation mark',
      appliesTo: 'tasks whose criteria assert exact output',
      timestamp: at,
    },
    {
      type: 'task-verified',
      output: `$ ${DEMO_CRITERION_COMMAND}\nexit 0`,
      timestamp: at,
    },
    {
      type: 'commit-message',
      subject: 'fix(demo): print the exact greeting the criterion asks for',
      body: 'Why: the first attempt dropped the comma and the exclamation mark, so the acceptance command exited 1.',
      timestamp: at,
    },
    { type: 'task-complete', timestamp: at },
  ]),
  body: `Applied the critique — ${DEMO_TARGET_FILE} now prints "Hello, world!" and the acceptance command exits 0.`,
});

/** Round 2 — the evaluator re-runs the criterion and PASSES every floor dimension. */
const evaluatorRoundTwo = (at: IsoTimestamp): DemoBeat => ({
  role: 'evaluator',
  round: 2,
  files: [],
  schemaVersion: evaluatorOutputContract.schemaVersion,
  signals: evaluatorSignals([
    {
      type: 'evaluation',
      status: 'passed',
      dimensions: [
        {
          dimension: 'correctness',
          passed: true,
          finding: `${DEMO_TARGET_FILE}:2 prints "Hello, world!" exactly`,
          executionEvidence: `$ ${DEMO_CRITERION_COMMAND}\nexit 0`,
        },
        {
          dimension: 'completeness',
          passed: true,
          finding: 'every step the task lists is reflected in the diff',
        },
        { dimension: 'safety', passed: true, finding: 'no shell, network, or dependency changes' },
        {
          dimension: 'consistency',
          passed: true,
          finding: 'the surrounding comment still matches the statement below it',
        },
        {
          dimension: 'robustness',
          passed: true,
          applicable: false,
          finding: 'a single literal print statement has no error path to harden',
        },
      ],
      criteria: [{ id: 'C1', passed: true, evidence: 'the acceptance command exited 0 on the committed tree' }],
      critique: "No remaining findings — the prior round's correctness gap is closed.",
      timestamp: at,
    },
  ]),
  body: 'PASSED — the acceptance criterion holds on the committed tree.',
});

/**
 * Build the two-round demo transcript.
 *
 * `now` is injected so a test can pin the timestamps; production passes the real clock, which
 * makes the rendered `signals.json` / `evaluation.md` artifacts carry the recording's own wall
 * clock rather than a stale literal a viewer would notice.
 */
export const demoTranscript = (now: () => IsoTimestamp = IsoTimestamp.now): DemoTranscript => {
  const at = now();
  return {
    beats: [generatorRoundOne(at), evaluatorRoundOne(at), generatorRoundTwo(at), evaluatorRoundTwo(at)],
  };
};

/**
 * Resolve the beat for a `rounds/<N>/<role>/` spawn.
 *
 * Rounds outside the script clamp to the nearest scripted round for that role rather than
 * returning `undefined`: a corrective nudge re-spawns the same round (exact hit), and a run that
 * somehow claims a third round gets the PASS beat, so the demo always converges instead of
 * looping until the turn budget runs out.
 *
 * @public
 */
export const beatFor = (transcript: DemoTranscript, role: DemoRole, round: number): DemoBeat | undefined => {
  const forRole = transcript.beats.filter((b) => b.role === role);
  if (forRole.length === 0) return undefined;
  const exact = forRole.find((b) => b.round === round);
  if (exact !== undefined) return exact;
  return round < 1 ? forRole[0] : forRole[forRole.length - 1];
};
