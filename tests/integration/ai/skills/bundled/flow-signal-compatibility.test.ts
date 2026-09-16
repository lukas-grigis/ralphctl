import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';
import { BUNDLED_SKILLS, type FlowId } from '@src/integration/ai/skills/_engine/registry.ts';
import { evaluatorOutputContract } from '@src/application/flows/implement/leaves/evaluator.contract.ts';
import { generatePrContentOutputContract } from '@src/application/flows/create-pr/leaves/generate-pr-content.contract.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';
import { ideateOutputContract } from '@src/application/flows/ideate/leaves/ideate.contract.ts';
import { planOutputContract } from '@src/application/flows/plan/leaves/plan.contract.ts';
import { readinessOutputContract } from '@src/application/flows/readiness/leaves/readiness.contract.ts';
import { refineOutputContract } from '@src/application/flows/refine/leaves/refine.contract.ts';

/**
 * Cross-check: every signal kind a bundled SKILL.md names in backticks must be one the output
 * contract of EVERY flow that skill can mount into will tolerate.
 *
 * `skillsForFlow` installs a skill's single SKILL.md verbatim into each phase listed in its
 * `defaultFor`, and the opt-in catalog offers the same body for each phase in `recommendedFor`
 * — there is no per-phase variant. The phases do NOT share a signal union: plan accepts
 * `task-plan` / `learning` / `note` / `decision`, readiness accepts neither `decision` nor any
 * `task-*` kind, and `validateSignalsFile` parses the array all-or-nothing, so ONE stray element
 * discards the whole payload. Corrective retry is wired into the implement flow only, so in
 * plan / ideate / readiness a user-approved session is simply lost.
 *
 * This is the direction `tests/integration/ai/prompts/template-signal-coverage.test.ts` does not
 * cover: that meta-test checks `expectedSignals` ⊆ template mentions, never skill mentions ⊆ what
 * the flow accepts. It regressed once — `ralphctl-iterative-review` (defaultFor: every flow) told
 * the model to surface a blocker as a `task-blocked` signal, a kind plan / ideate / readiness
 * reject outright, and `ralphctl-test-driven-development` / `ralphctl-debugging-and-error-recovery`
 * named `task-complete` and `decision` in prose offered to plan and readiness.
 *
 * The implement flow runs two AI turns — generator and evaluator — against two DIFFERENT
 * contracts from the one installed SKILL.md, so it appears twice in `FLOW_CONTRACTS` and a
 * mention has to survive both. The sibling `evaluator-signal-kind-mentions.test.ts` scans two
 * named skills heading-by-heading against the evaluator contract; it is the narrower check, not
 * the one that covers the evaluator turn for the other implement-mounted skills.
 */

const here = dirname(fileURLToPath(import.meta.url));
const bundledRoot = join(here, '..', '..', '..', '..', '..', 'src', 'integration', 'ai', 'skills', 'bundled');

const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Structural view of a contract, erased of its per-leaf signal sub-union — `AiOutputContract` is
 * invariant in `TSig` (the Zod schema appears in both positions), so a heterogeneous table cannot
 * hold the concrete contracts directly. Same bridge as
 * `tests/unit/application/flows/contract-example-narrative-signals.test.ts`.
 */
interface ContractProbe {
  /** The turn this contract belongs to — named in the failure message when it rejects a kind. */
  readonly turn: string;
  readonly signalsSchema: { readonly safeParse: (value: unknown) => { readonly success: boolean } };
  readonly exampleSignals: readonly AiSignal[];
}

const probe = <TSig extends AiSignal>(turn: string, contract: AiOutputContract<TSig>): ContractProbe => ({
  turn,
  signalsSchema: contract.signalsSchema,
  exampleSignals: contract.exampleSignals,
});

/**
 * Every contract a skill's prose can land in front of, per flow. `skillsForFlow` is keyed by
 * flow, not by role, so the implement flow's two AI turns receive the same SKILL.md and both
 * contracts have to tolerate what it names — a kind only the generator accepts needs the
 * `(generator role: …)` aside that `stripGeneratorAsides` below carves out.
 */
const FLOW_CONTRACTS: Readonly<Record<FlowId, readonly ContractProbe[]>> = {
  refine: [probe('refine', refineOutputContract)],
  plan: [probe('plan', planOutputContract)],
  implement: [probe('generator', generatorOutputContract), probe('evaluator', evaluatorOutputContract)],
  readiness: [probe('readiness', readinessOutputContract)],
  ideate: [probe('ideate', ideateOutputContract)],
  createPr: [probe('create-pr', generatePrContentOutputContract)],
};

/**
 * Minimal valid payload per signal kind. The kinds differ in required fields — `task-blocked`
 * needs `reason`, `task-verified` needs `output`, `task-complete` needs neither — so one generic
 * `{ type, text }` probe would report a false rejection for half of them.
 */
const PROBE_SIGNALS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  note: { type: 'note', text: 'probe', timestamp: EXAMPLE_TS },
  learning: { type: 'learning', text: 'probe', timestamp: EXAMPLE_TS },
  decision: { type: 'decision', text: 'probe', timestamp: EXAMPLE_TS },
  change: { type: 'change', text: 'probe', timestamp: EXAMPLE_TS },
  'task-complete': { type: 'task-complete', timestamp: EXAMPLE_TS },
  'task-verified': { type: 'task-verified', output: 'probe', timestamp: EXAMPLE_TS },
  'task-blocked': { type: 'task-blocked', reason: 'probe', timestamp: EXAMPLE_TS },
};

/**
 * Which of the flow's contracts would a signal of `kind` sink, alongside that contract's own
 * required payload? Empty means every turn of the flow tolerates it.
 *
 * The harm this test exists to prevent is the all-or-nothing REJECTION in
 * `validate-signals-file.ts`, not the drop: refine parses per element and create-pr filters
 * before validating, so a stray kind there costs nothing and must not be reported as a
 * violation. So the predicate is "the array still parses", deliberately weaker than the
 * "carries through to validated output" probe the narrative-kind unit grid uses.
 *
 * Any same-kind signal already in `exampleSignals` is swapped out rather than duplicated, so a
 * contract's cardinality refinement (exactly one `task-plan`, at most one `commit-message`) sees
 * the candidate as the single occurrence it requires.
 */
const rejectingTurns = (flow: FlowId, kind: string): readonly string[] => {
  const candidate = PROBE_SIGNALS[kind];
  if (candidate === undefined) throw new Error(`no probe payload for signal kind "${kind}" — add one above`);
  return FLOW_CONTRACTS[flow]
    .filter((contract) => {
      const base = contract.exampleSignals.filter((signal) => signal.type !== kind);
      return !contract.signalsSchema.safeParse([...base, candidate]).success;
    })
    .map((contract) => contract.turn);
};

// ── SKILL.md scanning ────────────────────────────────────────────────────────────────────────

const HEADING = /^#{1,6}\s/u;
const FENCE = /^\s*(?:```|~~~)/u;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/u;

/**
 * Split SKILL.md into logical passages — one bullet (with its hard-wrapped continuation lines),
 * one paragraph, one heading, one fenced block. A new passage starts at a blank line, a heading,
 * a fence delimiter, or a new list marker, so a bullet's own continuation lines stay attached to
 * it however the file wraps them, and two neighbouring bullets never merge into one scope.
 */
const splitPassages = (content: string): readonly string[] => {
  const passages: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const joined = current.join(' ').replace(/\s+/gu, ' ').trim();
    if (joined.length > 0) passages.push(joined);
    current = [];
  };
  for (const line of content.split('\n')) {
    const blank = line.trim() === '';
    if (blank || HEADING.test(line) || FENCE.test(line) || LIST_ITEM.test(line)) flush();
    if (blank) continue;
    current.push(line);
    if (HEADING.test(line) || FENCE.test(line)) flush();
  }
  flush();
  return passages;
};

// Same mention grammar as `evaluator-signal-kind-mentions.test.ts`: a run of backticked tokens
// sharing a trailing "signal"/"signals" noun — "a `note` signal", "`decision` or `note` signal",
// "`note` signals in `signals.json`". A backticked term with nothing named "signal(s)" after it
// (`` `signals.json` `` itself, `` `type` ``) is not a mention.
const SIGNAL_MENTION_SPAN = /(?:`[a-z][a-z-]*`(?:,\s*|\s+or\s+))*`[a-z][a-z-]*`\s+signals?\b/gu;
const BACKTICK_TOKEN = /`([a-z][a-z-]*)`/gu;

// A negation before the mention demotes it — "not as a `decision` signal" documents an exclusion
// rather than instructing one. Same demotion idea as `skill-contract-checker.ts`'s `isNegated`.
// Two scoping rules, both there because the loose form silently dropped real mentions: the match
// is word-bounded (a substring `not` also fires inside "note", "nothing", "cannot"), and only the
// mention's OWN sentence is searched (an earlier "…after each meaningful change, not after the
// whole diff." says nothing about the kind named in the next sentence).
const NEGATION = /\b(?:not|never|don't)\b/u;

const isNegatedMention = (lowerText: string, matchIndex: number): boolean => {
  const before = lowerText.slice(0, matchIndex);
  return NEGATION.test(before.split(/(?<=[.;!?])\s+/u).at(-1) ?? before);
};

const mentionedKinds = (text: string): readonly string[] => {
  const lowerText = text.toLowerCase();
  const kinds: string[] = [];
  for (const spanMatch of lowerText.matchAll(SIGNAL_MENTION_SPAN)) {
    if (isNegatedMention(lowerText, spanMatch.index)) continue;
    for (const tokenMatch of spanMatch[0].matchAll(BACKTICK_TOKEN)) {
      const token = tokenMatch[1];
      if (token) kinds.push(token);
    }
  }
  return kinds;
};

// A parenthetical naming the generator role is a carve-out for the implement flow's generator
// turn — "(generator role: a `decision` signal too)" — and is stripped before scanning; if
// "generator" still appears outside every such aside, the whole passage is framed for that role
// and is skipped. Identical treatment to the sibling evaluator test, for the same reason: the
// advice is dormant wherever no generator turn exists.
const stripGeneratorAsides = (passage: string): string => passage.replace(/\([^()]*generator[^()]*\)/giu, ' ');
const isGeneratorScoped = (strippedPassage: string): boolean => /generator/iu.test(strippedPassage);

/**
 * Phase labels the skills use in their "When this applies" bullets, mapped onto the flow each
 * one names. "Execute" is the skills' prose name for the implement flow.
 */
const PHASE_LABEL_TO_FLOW: Readonly<Record<string, FlowId>> = {
  refine: 'refine',
  plan: 'plan',
  ideate: 'ideate',
  execute: 'implement',
  implement: 'implement',
  readiness: 'readiness',
  'create pr': 'createPr',
  'create-pr': 'createPr',
};

// `- **Execute** — …` / `1. **Plan** — …`: a bold phase label opening a list item scopes that
// bullet to one phase, the way `ralphctl-iterative-review`'s "When this applies" list already
// does. The label class stops at the first comma or full stop, so a bold SENTENCE opening a
// bullet ("**When a fix attempt repeats the same failure, escalate rather than retry.**") yields
// no label and the passage stays unscoped — which is the whole point: unscoped advice is
// advice for every phase the skill mounts into.
const PHASE_SCOPE = /^(?:[-*+]|\d+[.)])\s+\*\*([a-z][a-z -]*)\*\*\s*—/u;

const scopedFlow = (passage: string): FlowId | undefined => {
  const label = PHASE_SCOPE.exec(passage.toLowerCase())?.[1]?.trim();
  return label === undefined ? undefined : PHASE_LABEL_TO_FLOW[label];
};

/** One (skill, flow, kind) obligation derived from one passage of one SKILL.md. */
interface MentionCase {
  readonly skill: string;
  readonly flow: FlowId;
  readonly kind: string;
  readonly passage: string;
}

const casesForSkill = (skill: string, flows: readonly FlowId[]): readonly MentionCase[] => {
  const content = readFileSync(join(bundledRoot, skill, 'SKILL.md'), 'utf-8');
  const cases: MentionCase[] = [];
  for (const rawPassage of splitPassages(content)) {
    const passage = stripGeneratorAsides(rawPassage);
    if (isGeneratorScoped(passage)) continue;
    const scope = scopedFlow(passage);
    const targets = scope === undefined ? flows : flows.filter((flow) => flow === scope);
    for (const kind of mentionedKinds(passage)) {
      for (const flow of targets) cases.push({ skill, flow, kind, passage: rawPassage });
    }
  }
  return cases;
};

const ALL_CASES: readonly MentionCase[] = BUNDLED_SKILLS.flatMap((entry) =>
  casesForSkill(entry.name, [...new Set([...entry.defaultFor, ...entry.recommendedFor])])
);

describe('bundled skills — every signal kind a skill names is tolerated by every flow it mounts into', () => {
  it('finds signal-kind mentions across several skills (guards against a vacuous pass)', () => {
    expect(ALL_CASES.length).toBeGreaterThan(0);
    expect(new Set(ALL_CASES.map((c) => c.skill)).size).toBeGreaterThanOrEqual(3);
  });

  it('probes every mentioned kind (a new signal kind must land with a probe payload)', () => {
    for (const { kind } of ALL_CASES) expect(Object.keys(PROBE_SIGNALS)).toContain(kind);
  });

  it.each(ALL_CASES.map((c) => [c.skill, c.flow, c.kind, c.passage] as const))(
    '%s in flow "%s": a `%s` signal does not sink the array — from: %s',
    (skill, flow, kind) => {
      const rejected = rejectingTurns(flow, kind);
      expect(
        rejected,
        `${skill} names a \`${kind}\` signal, but the ${flow} flow's ${rejected.join(' / ')} contract rejects ` +
          `it — the whole signals.json array fails to validate, and only the implement flow has a ` +
          `corrective-retry path.`
      ).toEqual([]);
    }
  );
});

describe('bundled skills — the pre-fix wordings this check exists to catch', () => {
  // The literal text each skill carried before the fix. Pinned here so the mechanism stays
  // covered even if the live SKILL.md prose is rewritten again later.
  const preFix: ReadonlyArray<{
    readonly label: string;
    readonly passage: string;
    readonly flow: FlowId;
    /** The phase label the passage scopes itself to, when it carries one. */
    readonly scope?: FlowId;
  }> = [
    {
      label: 'ralphctl-iterative-review — unscoped `task-blocked` in a skill defaultFor every flow',
      passage:
        '4. **When a fix attempt repeats the same failure, escalate rather than retry.** Two iterations of the same error is a plateau — the next fix is a guess. Surface the blocker as a `task-blocked` or `note` signal in `signals.json` rather than burning the budget.',
      flow: 'plan',
    },
    {
      label: 'ralphctl-test-driven-development — unscoped `task-complete`, recommendedFor plan and readiness',
      passage: 'Before writing the `task-complete` signal, confirm:',
      flow: 'readiness',
    },
    {
      label: 'ralphctl-debugging-and-error-recovery — unqualified `decision`, recommendedFor readiness',
      passage: '- [ ] Root cause is identified and documented (in a `note` or `decision` signal if non-obvious).',
      flow: 'readiness',
    },
    {
      // Execute-scoped and therefore invisible to plan / ideate / readiness — but the implement
      // flow installs the same file into its EVALUATOR turn, whose contract has no
      // `task-complete` schema. Also pins the word-bounded negation: the bullet's earlier "not
      // after the whole diff" demoted this mention while `not` was matched as a bare substring.
      label: 'ralphctl-iterative-review — Execute-scoped `task-complete`, which the evaluator turn also receives',
      passage:
        "- **Execute** — run the project's check gate (lint, typecheck, tests) after each meaningful change, not after the whole diff. Re-read your own diff once before you write a `task-complete` signal. You are the cheapest reviewer the change ever gets.",
      flow: 'implement',
      scope: 'implement',
    },
  ];

  for (const { label, passage, flow, scope } of preFix) {
    it(`would have failed: ${label}`, () => {
      const stripped = stripGeneratorAsides(passage);
      expect(isGeneratorScoped(stripped)).toBe(false);
      expect(scopedFlow(stripped)).toBe(scope);
      const rejected = mentionedKinds(stripped).filter((kind) => rejectingTurns(flow, kind).length > 0);
      expect(rejected.length).toBeGreaterThan(0);
    });
  }
});
