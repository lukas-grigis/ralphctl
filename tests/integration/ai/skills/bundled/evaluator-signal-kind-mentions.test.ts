import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { evaluatorOutputContract } from '@src/application/flows/implement/leaves/evaluator.contract.ts';

/**
 * Bundled skills `defaultFor: ['implement']` (registry.ts) materialise the SAME SKILL.md into
 * the repo's skills directory for both the generator turn and the evaluator turn of the
 * implement flow — there is no per-role skill variant. A bullet that tells an unqualified
 * reader (or explicitly "the evaluator") to write a signal kind the evaluator's OWN contract
 * does not accept teaches a contract the harness never parses: the whole `signals.json` array
 * fails to validate, taking the mandatory `evaluation` signal down with it.
 *
 * This regressed twice: `ralphctl-code-review-and-quality` instructed writing a `decision`
 * signal from a bullet and a checklist line that were not qualified to the generator, and
 * `ralphctl-karpathy-guidelines` did the same from its Mode 1 counter-habit bullet — in both
 * cases `evaluator.contract.ts`'s signal union has no `decision` schema. This test would have
 * failed against either unfixed wording; it fails again whenever a future edit re-widens an
 * evaluator-facing bullet, in either skill, to name a kind the real evaluator contract rejects.
 */

const here = dirname(fileURLToPath(import.meta.url));
const bundledRoot = join(here, '..', '..', '..', '..', '..', 'src', 'integration', 'ai', 'skills', 'bundled');

const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Does the real evaluator contract accept a narrative signal of `kind`? Probed via `safeParse`
 * against the contract's own (already-valid, exactly-one-`evaluation`) example payload plus one
 * candidate — the same probe technique
 * `tests/unit/application/flows/contract-example-narrative-signals.test.ts` uses for the
 * cross-contract narrative-kind grid, applied here to specific skill bullets instead.
 */
const evaluatorAccepts = (kind: string): boolean => {
  const payload = [...evaluatorOutputContract.exampleSignals, { type: kind, text: 'probe', timestamp: EXAMPLE_TS }];
  return evaluatorOutputContract.signalsSchema.safeParse(payload).success;
};

/**
 * Split a markdown section's body into logical bullets, joining each bullet's hard-wrapped
 * continuation lines into one string. Splitting only ever happens right before a line that
 * starts a NEW bullet (`- ` or `- [ ] `), so a bullet's own continuation lines — indented, no
 * leading `-` — stay attached to it regardless of how the file wraps them.
 */
const splitBullets = (section: string): readonly string[] =>
  section
    .split(/\n(?=-\s)/u)
    .map((bullet) => bullet.replace(/\s+/gu, ' ').trim())
    .filter((bullet) => bullet.startsWith('-'));

/** The body of one `##`/`###` markdown section, heading line excluded, up to the next heading. */
const extractSection = (content: string, heading: string): string => {
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  if (startIndex === -1) throw new Error(`heading not found in SKILL.md: "${heading}"`);
  const rest = lines.slice(startIndex + 1);
  const endIndex = rest.findIndex((line) => /^#{1,6}\s/u.test(line));
  return (endIndex === -1 ? rest : rest.slice(0, endIndex)).join('\n');
};

// Matches a run of one or more backtick-quoted tokens sharing a trailing "signal"/"signals" noun
// — "a `note` signal", "`decision` or `note` signal", "`note` signals in `signals.json`" — but
// not an unrelated backticked term like `` `signals.json` `` itself (nothing named "signal(s)"
// follows its closing backtick).
const SIGNAL_MENTION_SPAN = /(?:`[a-z][a-z-]*`(?:,\s*|\s+or\s+))*`[a-z][a-z-]*`\s+signals?\b/gu;
const BACKTICK_TOKEN = /`([a-z][a-z-]*)`/gu;

// A negation appearing anywhere before the mention span in the same bullet demotes it: "not as a
// `decision` signal" documents the exclusion this test enforces, it is not an instruction to
// write one. Same demotion idea as `skill-contract-checker.ts`'s `isNegated`.
const NEGATION_WORDS = ['not', 'never', "don't", 'do not'] as const;

const isNegatedMention = (lowerText: string, matchIndex: number): boolean => {
  const before = lowerText.slice(0, matchIndex);
  return NEGATION_WORDS.some((word) => before.includes(word));
};

/**
 * Non-negated signal-kind mentions in `text` — an instruction to write that kind, not a denial.
 * A shared-noun list ("`decision` or `note` signal") yields every token in the list, not just the
 * one immediately before "signal".
 */
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

// A parenthetical aside that itself mentions "generator" is a carve-out for a kind that only
// applies to the generator role — e.g. "(generator role: `decision` too)" — and is stripped
// before scanning: the advice OUTSIDE it is what remains for both roles (or is unqualified,
// hence must be evaluator-safe). If "generator" still appears outside every such aside, the
// bullet's remaining advice is framed for the generator as a whole (e.g. "When acting as the
// **generator**, write a ... signal") and the whole bullet is excluded.
const stripGeneratorAsides = (bullet: string): string => bullet.replace(/\([^()]*generator[^()]*\)/giu, ' ');
const isGeneratorScoped = (strippedBullet: string): boolean => /generator/iu.test(strippedBullet);

/** One bundled skill's evaluator-facing sections to scan, by exact heading text. */
interface SkillScanTarget {
  readonly skill: string;
  readonly headings: readonly string[];
}

const SCAN_TARGETS: readonly SkillScanTarget[] = [
  {
    skill: 'ralphctl-code-review-and-quality',
    headings: ['### Step 4: Surface Findings via Signals', '## Review Checklist'],
  },
  {
    skill: 'ralphctl-karpathy-guidelines',
    headings: ['## Mode 1 — Silent assumptions'],
  },
];

describe('bundled skills — evaluator-facing signal-kind mentions match the real evaluator contract', () => {
  for (const { skill, headings } of SCAN_TARGETS) {
    describe(skill, () => {
      const content = readFileSync(join(bundledRoot, skill, 'SKILL.md'), 'utf-8');
      const evaluatorFacingBullets = headings
        .flatMap((heading) => splitBullets(extractSection(content, heading)))
        .map(stripGeneratorAsides)
        .filter((bullet) => !isGeneratorScoped(bullet));

      const mentions = evaluatorFacingBullets.flatMap((bullet) =>
        mentionedKinds(bullet).map((kind) => ({ kind, bullet }))
      );

      it('finds at least one evaluator-facing signal-kind mention (guards against a vacuous pass)', () => {
        expect(mentions.length).toBeGreaterThan(0);
      });

      it.each(mentions.map(({ kind, bullet }) => [kind, bullet] as const))(
        'kind "%s" is accepted by the real evaluator contract — from: %s',
        (kind) => {
          expect(evaluatorAccepts(kind), `evaluator.contract.ts rejects a "${kind}" signal`).toBe(true);
        }
      );
    });
  }

  it('regression: the pre-fix unqualified `decision` wording would have failed this check', () => {
    // Same bullet text as before each fix, minus the generator qualifier — pins the mechanism
    // this test exists to catch, independent of the live SKILL.md content scanned above.
    const preFixBullets = [
      '- Write a `decision` signal when a Critical or Major finding changes the approach — record what was found and why the current direction was adjusted.',
      '- When the task is ambiguous, name the ambiguity before acting. With an interactive channel, ask; without one, state the interpretation you chose and why in a `decision` or `note` signal in `signals.json`, then proceed with the least-surprising reading.',
    ];
    for (const bullet of preFixBullets) {
      expect(isGeneratorScoped(bullet)).toBe(false);
      expect(mentionedKinds(bullet)).toContain('decision');
      expect(evaluatorAccepts('decision')).toBe(false);
    }
  });
});
